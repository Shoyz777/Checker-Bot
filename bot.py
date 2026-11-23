import asyncio
import html
import logging
import os

import aiohttp
from aiohttp import web
from aiogram import Bot, Dispatcher, types
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandObject

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Загружаем настройки из переменных окружения Render
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
STEAM_API_KEY = os.getenv("STEAM_API_KEY")
FRIEND_STEAM_ID = os.getenv("FRIEND_STEAM_ID")
TELEGRAM_CHAT_ID = int(os.getenv("TELEGRAM_CHAT_ID", "0"))
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL", "60"))  # Проверка раз в 60 секунд

# Настройки фильтра (можно менять прямо командами в Telegram)
settings = {
    "target_game": os.getenv("TARGET_GAME", "").strip(),  # Пусто = уведомлять о любой игре
    "muted": False,
}

PERSONA_STATES = {
    0: "⚫ Оффлайн",
    1: "🟢 В сети",
    2: "🔴 Занят",
    3: "🟡 Отошел",
    4: "💤 Спит",
    5: "🔄 Хочет обменяться",
    6: "🎮 Хочет поиграть",
}

bot = Bot(token=TELEGRAM_TOKEN)
dp = Dispatcher()


async def fetch_steam_player(session: aiohttp.ClientSession) -> dict | None:
    """Запрашивает текущий статус друга через Steam Web API."""
    url = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
    params = {"key": STEAM_API_KEY, "steamids": FRIEND_STEAM_ID}
    try:
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                logging.warning("Steam API вернул статус %s", resp.status)
                return None
            data = await resp.json()
            players = data.get("response", {}).get("players", [])
            return players[0] if players else None
    except Exception as e:
        logging.error("Ошибка запроса к Steam API: %s", e)
        return None


async def steam_monitor_loop():
    """Фоновый цикл отслеживания статуса и игр друга."""
    initialized = False
    was_online = False
    offline_streak = 0
    last_game = None

    async with aiohttp.ClientSession() as session:
        while True:
            player = await fetch_steam_player(session)

            if player:
                name = html.escape(player.get("personaname", "Друг"))
                personastate = player.get("personastate", 0)
                current_game = player.get("gameextrainfo")  # None, если не в игре
                is_online = (personastate != 0) or (current_game is not None)

                # При первом запуске просто запоминаем текущее состояние без спама
                if not initialized:
                    was_online = is_online
                    last_game = current_game
                    initialized = True
                    logging.info(
                        "Инициализация: %s | online=%s | game=%s",
                        name, is_online, current_game
                    )
                else:
                    notifications = []

                    # 1. Проверка выхода в сеть (с защитой от кратковременного разрыва связи)
                    if is_online:
                        offline_streak = 0
                        if not was_online:
                            was_online = True
                            notifications.append(f"🟢 <b>{name}</b> зашел(а) в Steam!")
                    else:
                        offline_streak += 1
                        if offline_streak >= 2:  # Считаем оффлайном после 2 проверок подряд
                            was_online = False

                    # 2. Проверка запуска игры
                    if current_game and current_game != last_game:
                        target = settings["target_game"]
                        if not target or target.lower() in current_game.lower():
                            safe_game = html.escape(current_game)
                            notifications.append(f"🎮 <b>{name}</b> запустил(а) <b>{safe_game}</b>!")

                    last_game = current_game

                    # Отправка уведомления
                    if notifications and not settings["muted"]:
                        try:
                            await bot.send_message(
                                chat_id=TELEGRAM_CHAT_ID,
                                text="\n".join(notifications),
                                parse_mode=ParseMode.HTML,
                            )
                        except Exception as e:
                            logging.error("Не удалось отправить сообщение в Telegram: %s", e)

            await asyncio.sleep(CHECK_INTERVAL)


# --- Команды управления ботом ---

def is_owner(message: types.Message) -> bool:
    return message.chat.id == TELEGRAM_CHAT_ID


@dp.message(Command("start", "help"))
async def cmd_start(message: types.Message):
    if not is_owner(message):
        return
    game_filter = settings["target_game"] or "Любая игра"
    mute_state = "Выключены 🔕" if settings["muted"] else "Включены 🔔"
    text = (
        "<b>Steam-трекер активен</b>\n\n"
        f"🎯 Фильтр игры: <code>{html.escape(game_filter)}</code>\n"
        f"📢 Уведомления: {mute_state}\n\n"
        "<b>Команды:</b>\n"
        "/status — проверить друга прямо сейчас\n"
        "/setgame &lt;название&gt; — следить за конкретной игрой (напр. <code>/setgame Counter-Strike</code>)\n"
        "/anygame — уведомлять о запуске любых игр\n"
        "/mute — поставить уведомления на паузу / включить обратно"
    )
    await message.answer(text, parse_mode=ParseMode.HTML)


@dp.message(Command("status"))
async def cmd_status(message: types.Message):
    if not is_owner(message):
        return
    async with aiohttp.ClientSession() as session:
        player = await fetch_steam_player(session)

    if not player:
        await message.answer("⚠️ Не удалось получить данные от Steam. Проверьте API-ключ или приватность профиля.")
        return

    name = html.escape(player.get("personaname", "Друг"))
    state_text = PERSONA_STATES.get(player.get("personastate", 0), "Неизвестно")
    game = player.get("gameextrainfo")

    text = f"👤 <b>{name}</b>\nСтатус: {state_text}"
    if game:
        text += f"\n🎮 В игре: <b>{html.escape(game)}</b>"
    await message.answer(text, parse_mode=ParseMode.HTML)


@dp.message(Command("setgame"))
async def cmd_setgame(message: types.Message, command: CommandObject):
    if not is_owner(message):
        return
    if not command.args:
        await message.answer("Укажите название игры после команды, например:\n<code>/setgame Dota 2</code>", parse_mode=ParseMode.HTML)
        return
    settings["target_game"] = command.args.strip()
    await message.answer(
        f"🎯 Теперь уведомления по играм приходят только для: <b>{html.escape(settings['target_game'])}</b>",
        parse_mode=ParseMode.HTML,
    )


@dp.message(Command("anygame"))
async def cmd_anygame(message: types.Message):
    if not is_owner(message):
        return
    settings["target_game"] = ""
    await message.answer("🎮 Фильтр сброшен — буду уведомлять о запуске любой игры.")


@dp.message(Command("mute"))
async def cmd_mute(message: types.Message):
    if not is_owner(message):
        return
    settings["muted"] = not settings["muted"]
    status = "🔕 Уведомления на паузе." if settings["muted"] else "🔔 Уведомления снова включены."
    await message.answer(status)


# --- Веб-сервер для Render ---

async def handle_health(request: web.Request) -> web.Response:
    return web.Response(text="Steam Telegram Bot is running")


async def main():
    # Запускаем HTTP-сервер на порту, который выдаст Render
    app = web.Application()
    app.router.add_get("/", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8080"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logging.info("HTTP-сервер запущен на порту %s", port)

    # Запускаем фоновый мониторинг Steam
    monitor_task = asyncio.create_task(steam_monitor_loop())

    try:
        # Удаляем старые вебхуки, если были, и запускаем прием команд Telegram
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    finally:
        monitor_task.cancel()
        await runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
