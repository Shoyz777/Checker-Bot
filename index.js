const STATE_KEY = "steam_bot_state_v2";

const PERSONA_STATES = {
  0: "⚫ Оффлайн",
  1: "🟢 В сети",
  2: "🔴 Занят",
  3: "🟡 Отошел",
  4: "💤 Спит",
  5: "🔄 Хочет обменяться",
  6: "🎮 Хочет поиграть",
};

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadState(env) {
  const saved = await env.BOT_KV.get(STATE_KEY, { type: "json" });
  const state = {
    friends: {},
    target_game: (env.TARGET_GAME || "").trim(),
    muted: false,
    env_seeded: false,
    ...(saved || {}),
  };

  // Автоматически переносим друга из переменной окружения при первом запуске
  if (!state.env_seeded && env.FRIEND_STEAM_ID) {
    const id = String(env.FRIEND_STEAM_ID).trim();
    if (/^\d{17}$/.test(id) && !state.friends[id]) {
      state.friends[id] = {
        name: id,
        initialized: false,
        was_online: false,
        offline_streak: 0,
        last_game: null,
      };
    }
    state.env_seeded = true;
  }

  return state;
}

async function sendTelegram(env, chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );
  if (!res.ok) {
    console.error("Telegram API error:", await res.text());
  }
}

/**
 * Превращает SteamID64, ссылку /profiles/... или кастомную ссылку /id/... в 17-значный SteamID64
 */
async function resolveSteamId(env, rawInput, allowPlainVanity = false) {
  const input = String(rawInput || "").trim();
  if (!input) return null;

  // 1. Чистый 17-значный SteamID64
  if (/^\d{17}$/.test(input)) {
    return input;
  }

  // 2. Ссылка вида steamcommunity.com/profiles/7656119...
  const profileMatch = input.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileMatch) {
    return profileMatch[1];
  }

  // 3. Кастомная ссылка вида steamcommunity.com/id/custom_name
  let vanity = null;
  const vanityMatch = input.match(/steamcommunity\.com\/id\/([^\/\?\s#]+)/i);
  if (vanityMatch) {
    vanity = vanityMatch[1];
  } else if (allowPlainVanity && /^[a-zA-Z0-9_-]{2,64}$/.test(input)) {
    vanity = input;
  }

  if (!vanity) return null;

  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(
    env.STEAM_API_KEY
  )}&vanityurl=${encodeURIComponent(vanity)}`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  if (data?.response?.success === 1 && data?.response?.steamid) {
    return data.response.steamid;
  }

  return null;
}

/**
 * Запрашивает данные сразу по всем SteamID (до 100 штук за один запрос)
 */
async function fetchSteamPlayers(env, steamIds) {
  if (!steamIds || steamIds.length === 0) return {};

  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(
    env.STEAM_API_KEY
  )}&steamids=${encodeURIComponent(steamIds.join(","))}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error("Steam API status:", res.status);
    return null;
  }

  const data = await res.json();
  const players = data?.response?.players || [];
  const map = {};
  for (const p of players) {
    map[p.steamid] = p;
  }
  return map;
}

async function checkSteam(env) {
  if (!env.BOT_KV) return "Ошибка: не привязано KV-хранилище BOT_KV";

  const state = await loadState(env);
  const prevSnapshot = JSON.stringify(state);
  const steamIds = Object.keys(state.friends);

  if (steamIds.length === 0) {
    if (JSON.stringify(state) !== prevSnapshot) {
      await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
    }
    return "OK | Список друзей пуст";
  }

  const playersMap = await fetchSteamPlayers(env, steamIds);
  if (!playersMap) return "Не удалось получить данные от Steam API";

  const notifications = [];
  const summaryParts = [];

  for (const id of steamIds) {
    const player = playersMap[id];
    const friend = state.friends[id];
    if (!player || !friend) continue;

    const rawName = player.personaname || friend.name || id;
    friend.name = rawName;
    const name = escapeHtml(rawName);
    const personastate = player.personastate ?? 0;
    const currentGame = player.gameextrainfo || null;
    const isOnline = personastate !== 0 || currentGame !== null;

    summaryParts.push(`${rawName}: online=${isOnline}, game=${currentGame || "none"}`);

    if (!friend.initialized) {
      friend.was_online = isOnline;
      friend.last_game = currentGame;
      friend.offline_streak = isOnline ? 0 : 2;
      friend.initialized = true;
      continue;
    }

    // 1. Вход в сеть (с защитой от мигания на 1 проверку)
    if (isOnline) {
      friend.offline_streak = 0;
      if (!friend.was_online) {
        friend.was_online = true;
        notifications.push(`🟢 <b>${name}</b> зашел(а) в Steam!`);
      }
    } else if (friend.was_online) {
      friend.offline_streak += 1;
      if (friend.offline_streak >= 2) {
        friend.was_online = false;
      }
    }

    // 2. Запуск игры
    if (currentGame && currentGame !== friend.last_game) {
      const target = (state.target_game || "").trim();
      if (!target || currentGame.toLowerCase().includes(target.toLowerCase())) {
        notifications.push(
          `🎮 <b>${name}</b> запустил(а) <b>${escapeHtml(currentGame)}</b>!`
        );
      }
    }

    friend.last_game = currentGame;
  }

  if (notifications.length > 0 && !state.muted) {
    await sendTelegram(env, env.TELEGRAM_CHAT_ID, notifications.join("\n"));
  }

  // Пишем в KV только если изменилось состояние
  if (JSON.stringify(state) !== prevSnapshot) {
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
  }

  return `OK | ${summaryParts.join(" ; ")}`;
}

async function addFriendFlow(env, chatId, rawInput, allowPlainVanity) {
  const steamId = await resolveSteamId(env, rawInput, allowPlainVanity);
  if (!steamId) {
    await sendTelegram(
      env,
      chatId,
      "❌ Не удалось распознать профиль Steam.\nПришли 17-значный SteamID64 или ссылку вида:\n<code>https://steamcommunity.com/id/ник</code>"
    );
    return;
  }

  const state = await loadState(env);
  if (state.friends[steamId]) {
    await sendTelegram(
      env,
      chatId,
      `ℹ️ <b>${escapeHtml(state.friends[steamId].name)}</b> (<code>${steamId}</code>) уже есть в списке отслеживания.`
    );
    return;
  }

  const playersMap = await fetchSteamPlayers(env, [steamId]);
  const player = playersMap?.[steamId];
  if (!player) {
    await sendTelegram(
      env,
      chatId,
      "⚠️ Профиль с таким ID не найден в Steam или API временно недоступен."
    );
    return;
  }

  const rawName = player.personaname || steamId;
  const currentGame = player.gameextrainfo || null;
  const isOnline = (player.personastate ?? 0) !== 0 || currentGame !== null;

  state.friends[steamId] = {
    name: rawName,
    initialized: true,
    was_online: isOnline,
    offline_streak: isOnline ? 0 : 2,
    last_game: currentGame,
  };

  await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));

  const stateText = PERSONA_STATES[player.personastate ?? 0] || "Неизвестно";
  let msg =
    `✅ Добавлен в отслеживание: <b>${escapeHtml(rawName)}</b>\n` +
    `🆔 <code>${steamId}</code>\n` +
    `Сейчас: ${stateText}`;

  if (currentGame) {
    msg += ` — 🎮 <b>${escapeHtml(currentGame)}</b>`;
  }

  // Проверка видимости профиля (3 = Public)
  if (player.communityvisibilitystate !== 3) {
    msg +=
      "\n\n⚠️ <i>Внимание: у этого профиля ограничена приватность. Пока друг не откроет профиль и игровую активность для всех, Steam не будет отдавать его статус.</i>";
  }

  await sendTelegram(env, chatId, msg);
}

async function handleWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update?.message;
  if (!message?.text) return new Response("OK");

  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response("OK");
  }

  const text = message.text.trim();

  // Если пользователь просто скинул ссылку на Steam или 17-значный ID без команды — сразу добавляем
  if (!text.startsWith("/")) {
    if (/^\d{17}$/.test(text) || /steamcommunity\.com\/(profiles|id)\//i.test(text)) {
      await addFriendFlow(env, message.chat.id, text, false);
    }
    return new Response("OK");
  }

  const firstToken = text.split(/\s+/)[0];
  const cmd = firstToken.split("@")[0].toLowerCase();
  const args = text.slice(firstToken.length).trim();

  if (cmd === "/start" || cmd === "/help") {
    const state = await loadState(env);
    const count = Object.keys(state.friends).length;
    const gameFilter = state.target_game || "Любая игра";
    const muteState = state.muted ? "Выключены 🔕" : "Включены 🔔";

    await sendTelegram(
      env,
      message.chat.id,
      "<b>Steam-трекер активен</b>\n\n" +
        `👥 Отслеживается друзей: <b>${count}</b>\n` +
        `🎯 Фильтр игры: <code>${escapeHtml(gameFilter)}</code>\n` +
        `📢 Уведомления: ${muteState}\n\n` +
        "<b>Команды:</b>\n" +
        "/add &lt;ссылка или ID&gt; — добавить друга (можно просто кинуть ссылку в чат)\n" +
        "/del &lt;ник, ID или номер&gt; — удалить друга\n" +
        "/list или /status — статус всех друзей\n" +
        "/setgame &lt;название&gt; — следить за конкретной игрой\n" +
        "/anygame — уведомлять о любых играх\n" +
        "/mute — пауза / возобновить уведомления"
    );
  } else if (cmd === "/add") {
    if (!args) {
      await sendTelegram(
        env,
        message.chat.id,
        "Пришли ссылку на профиль Steam или SteamID64:\n<code>/add https://steamcommunity.com/id/ник</code>"
      );
      return new Response("OK");
    }
    await addFriendFlow(env, message.chat.id, args, true);
  } else if (cmd === "/del" || cmd === "/remove") {
    if (!args) {
      await sendTelegram(
        env,
        message.chat.id,
        "Укажи номер из /list, ник или SteamID друга:\n<code>/del 1</code>"
      );
      return new Response("OK");
    }

    const state = await loadState(env);
    const entries = Object.entries(state.friends);
    let targetId = null;

    // Поиск по порядковому номеру из /list
    if (/^\d{1,3}$/.test(args)) {
      const idx = parseInt(args, 10) - 1;
      if (entries[idx]) targetId = entries[idx][0];
    }
    // Поиск по точному SteamID
    if (!targetId && state.friends[args]) {
      targetId = args;
    }
    // Поиск по нику (без учета регистра)
    if (!targetId) {
      const query = args.toLowerCase();
      const found = entries.find(([, info]) =>
        (info.name || "").toLowerCase().includes(query)
      );
      if (found) targetId = found[0];
    }

    if (!targetId) {
      await sendTelegram(env, message.chat.id, "❌ Друг не найден в списке. Проверь /list.");
      return new Response("OK");
    }

    const removedName = state.friends[targetId].name;
    delete state.friends[targetId];
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));

    await sendTelegram(
      env,
      message.chat.id,
      `🗑 Удален из отслеживания: <b>${escapeHtml(removedName)}</b> (<code>${targetId}</code>)`
    );
  } else if (cmd === "/list" || cmd === "/status") {
    const state = await loadState(env);
    const steamIds = Object.keys(state.friends);

    if (steamIds.length === 0) {
      await sendTelegram(
        env,
        message.chat.id,
        "Список пуст. Просто скинь в чат ссылку на профиль Steam или SteamID64, чтобы добавить друга."
      );
      return new Response("OK");
    }

    const playersMap = await fetchSteamPlayers(env, steamIds);
    if (!playersMap) {
      await sendTelegram(
        env,
        message.chat.id,
        "⚠️ Не удалось получить данные от Steam API. Попробуй позже."
      );
      return new Response("OK");
    }

    const lines = ["<b>Отслеживаемые игроки:</b>\n"];
    let changed = false;

    steamIds.forEach((id, index) => {
      const player = playersMap[id];
      const friend = state.friends[id];
      const rawName = player?.personaname || friend.name || id;
      if (friend.name !== rawName) {
        friend.name = rawName;
        changed = true;
      }

      const stateText = player
        ? PERSONA_STATES[player.personastate ?? 0] || "Неизвестно"
        : "⚠️ Нет данных";
      const game = player?.gameextrainfo;

      let line = `${index + 1}. <b>${escapeHtml(rawName)}</b> — ${stateText}`;
      if (game) {
        line += ` (🎮 <b>${escapeHtml(game)}</b>)`;
      }
      line += `\n    <code>${id}</code>`;
      lines.push(line);
    });

    if (changed) {
      await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
    }

    await sendTelegram(env, message.chat.id, lines.join("\n"));
  } else if (cmd === "/setgame") {
    if (!args) {
      await sendTelegram(
        env,
        message.chat.id,
        "Укажи название игры после команды, например:\n<code>/setgame Counter-Strike</code>"
      );
      return new Response("OK");
    }
    const state = await loadState(env);
    state.target_game = args;
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
    await sendTelegram(
      env,
      message.chat.id,
      `🎯 Теперь уведомления по играм приходят только для: <b>${escapeHtml(args)}</b>`
    );
  } else if (cmd === "/anygame") {
    const state = await loadState(env);
    state.target_game = "";
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
    await sendTelegram(
      env,
      message.chat.id,
      "🎮 Фильтр сброшен — буду уведомлять о запуске любой игры."
    );
  } else if (cmd === "/mute") {
    const state = await loadState(env);
    state.muted = !state.muted;
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
    await sendTelegram(
      env,
      message.chat.id,
      state.muted ? "🔕 Уведомления на паузе." : "🔔 Уведомления снова включены."
    );
  }

  return new Response("OK");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkSteam(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.TELEGRAM_TOKEN) {
        return new Response("TELEGRAM_TOKEN не задан", { status: 500 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(
          webhookUrl
        )}`
      );
      return new Response(await res.text(), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/test") {
      const result = await checkSteam(env);
      return new Response(result, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Steam Checker Bot is running on Cloudflare Workers");
  },
};
