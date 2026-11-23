const STATE_KEY = "steam_bot_state";

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
  return {
    initialized: false,
    was_online: false,
    offline_streak: 0,
    last_game: null,
    target_game: (env.TARGET_GAME || "").trim(),
    muted: false,
    ...(saved || {}),
  };
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
      }),
    }
  );
  if (!res.ok) {
    console.error("Telegram API error:", await res.text());
  }
}

async function fetchSteamPlayer(env) {
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(
    env.STEAM_API_KEY
  )}&steamids=${encodeURIComponent(env.FRIEND_STEAM_ID)}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error("Steam API status:", res.status);
    return null;
  }

  const data = await res.json();
  const players = data?.response?.players || [];
  return players[0] || null;
}

async function checkSteam(env) {
  if (!env.BOT_KV) return "Ошибка: не привязано KV-хранилище BOT_KV";

  const player = await fetchSteamPlayer(env);
  if (!player) return "Не удалось получить данные от Steam API";

  const state = await loadState(env);
  const prevSnapshot = JSON.stringify(state);

  const name = escapeHtml(player.personaname || "Друг");
  const personastate = player.personastate ?? 0;
  const currentGame = player.gameextrainfo || null;
  const isOnline = personastate !== 0 || currentGame !== null;

  if (!state.initialized) {
    state.was_online = isOnline;
    state.last_game = currentGame;
    state.offline_streak = isOnline ? 0 : 2;
    state.initialized = true;
  } else {
    const notifications = [];

    // 1. Вход в сеть (с защитой от кратковременного разрыва связи на 1 проверку)
    if (isOnline) {
      state.offline_streak = 0;
      if (!state.was_online) {
        state.was_online = true;
        notifications.push(`🟢 <b>${name}</b> зашел(а) в Steam!`);
      }
    } else if (state.was_online) {
      state.offline_streak += 1;
      if (state.offline_streak >= 2) {
        state.was_online = false;
      }
    }

    // 2. Запуск игры
    if (currentGame && currentGame !== state.last_game) {
      const target = (state.target_game || "").trim();
      if (!target || currentGame.toLowerCase().includes(target.toLowerCase())) {
        notifications.push(
          `🎮 <b>${name}</b> запустил(а) <b>${escapeHtml(currentGame)}</b>!`
        );
      }
    }

    state.last_game = currentGame;

    if (notifications.length > 0 && !state.muted) {
      await sendTelegram(env, env.TELEGRAM_CHAT_ID, notifications.join("\n"));
    }
  }

  // Сохраняем в KV только если состояние реально изменилось
  if (JSON.stringify(state) !== prevSnapshot) {
    await env.BOT_KV.put(STATE_KEY, JSON.stringify(state));
  }

  return `OK | ${player.personaname} | online=${isOnline} | game=${currentGame || "none"}`;
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

  // Отвечаем только владельцу
  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response("OK");
  }

  const text = message.text.trim();
  const firstToken = text.split(/\s+/)[0];
  const cmd = firstToken.split("@")[0].toLowerCase();
  const args = text.slice(firstToken.length).trim();

  if (cmd === "/start" || cmd === "/help") {
    const state = await loadState(env);
    const gameFilter = state.target_game || "Любая игра";
    const muteState = state.muted ? "Выключены 🔕" : "Включены 🔔";

    await sendTelegram(
      env,
      message.chat.id,
      "<b>Steam-трекер активен (Cloudflare Workers)</b>\n\n" +
        `🎯 Фильтр игры: <code>${escapeHtml(gameFilter)}</code>\n` +
        `📢 Уведомления: ${muteState}\n\n` +
        "<b>Команды:</b>\n" +
        "/status — проверить друга прямо сейчас\n" +
        "/setgame &lt;название&gt; — следить за конкретной игрой\n" +
        "/anygame — уведомлять о запуске любых игр\n" +
        "/mute — пауза / возобновить уведомления"
    );
  } else if (cmd === "/status") {
    const player = await fetchSteamPlayer(env);
    if (!player) {
      await sendTelegram(
        env,
        message.chat.id,
        "⚠️ Не удалось получить данные от Steam. Проверь ключ или приватность профиля."
      );
      return new Response("OK");
    }

    const name = escapeHtml(player.personaname || "Друг");
    const stateText = PERSONA_STATES[player.personastate ?? 0] || "Неизвестно";
    let reply = `👤 <b>${name}</b>\nСтатус: ${stateText}`;
    if (player.gameextrainfo) {
      reply += `\n🎮 В игре: <b>${escapeHtml(player.gameextrainfo)}</b>`;
    }
    await sendTelegram(env, message.chat.id, reply);
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

    // Вебхук для команд Telegram
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    // Одноразовая привязка вебхука Telegram: открой /setup в браузере
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.TELEGRAM_TOKEN) {
        return new Response("TELEGRAM_TOKEN не задан в Variables and Secrets", {
          status: 500,
        });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(
          webhookUrl
        )}`
      );
      const data = await res.text();
      return new Response(data, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Ручной тест проверки Steam: открой /test в браузере
    if (request.method === "GET" && url.pathname === "/test") {
      const result = await checkSteam(env);
      return new Response(result, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Steam Checker Bot is running on Cloudflare Workers");
  },
};
