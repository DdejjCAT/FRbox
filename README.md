# FRbox

Приватный сервер для Jackbox Games (паки **JPP1–TMP3**), написанный на Node.js.
Совместим с клиентом контроллера Ecast и устаревшим протоколом Blobcast (Socket.IO v1).
Автор: **@error_kill**.

> В репозитории лежит **только сервер**. Файлы сайта-оболочки (контроллер) и бинарник
> Xray файлы сюда не входят — их нужно установить отдельно (см. разделы ниже).
> Готовый **полный сайт-оболочка** лежит в отдельном репозитории: https://github.com/DdejjCAT/FRbox-site
---

Основной сервер: 
jack.nevpn2.fenst4r.live

Освновной контроллер:
https://jpp.nevpn2.fenst4r.live

Для указывания кастомных серверов в играх Jackbox используйте параметр запуска:
-jbg.config serverUrl=сервер

В Trivia Murder Party 3 нужно изменить сервер через HxD
 https://mh-nexus.de/en/hxd/

## Возможности

- HTTP API Ecast: создание комнат, каталог игр, комната/префлайт, accessToken.
- WebSocket-мост **Ecast ↔ Blobcast** (старые пакеты через Socket.IO v1).
- Обход гео-блокировок через **Xray** (socks5 на `127.0.0.1`).
- Веб-дашборд, регистрация/вход, управление комнатами, банами и IP.
- Защита от брутфорса и DDoS, бан-лист IP.

---

## Структура репозитория

```
main.js            — сам сервер
config.json        — конфигурация
games.json         — таблица appTag → appId
public/            — веб-дашборд (index.html — вход, dashboard.html — панель, room.html)
package.json       — зависимости и скрипты
```

Каталоги `node_modules/`, `data/`, `certs/`, `xray-bin/`, `backups/`, `oldservers/`
создаются локально и в репозиторий не коммитятся (см. `.gitignore`).

---

## Требования

- **Node.js 18+** (используется `fetch`; проверено на Node 24).
- **npm**.
- домен и SSL-сертификат (для работы клиентов Jackbox нужен **HTTPS/WSS**).
- (опционально) **Xray-core** — чтобы ходить к официальным серверам Jackbox из региона,
  где они недоступны.
- (опционально) **Xray-подписка** или список `vless://`, `vmess://`, `trojan://`, `ss://`
  ссылок.

---

## Быстрый старт

```bash
# 1. Клонировать
git clone https://github.com/DdejjCAT/FRbox FRbox
cd FRbox

# 2. Установить зависимости
npm install

# 3. Отредактировать config.json (см. ниже)
nano config.json

# 4. Запустить
npm start
# или: node main.js
```

По умолчанию сервер слушает `0.0.0.0:3489`.

---

## config.json

```jsonc
{
  "port": 3489,                       // порт, на котором слушает сервер
  "host": "jack.example.com",         // публичный хост, отдаётся клиентам в ответах API

  "internalToken": "CHANGE_ME",        // токен для админ-API (заголовок x-internal-token)

  "mitm": {
    "enabled": false,                  // режим зеркала официального сервера
    "mirrorUrl": "https://ecast-qa.jackboxgames.com"
  },

  "xrayBin": "./xray-bin/xray",        // путь к бинарнику Xray
  "xrayLocalPort": 10808,              // локальный socks5-порт Xray
  "xraySubscription": "",              // URL подписки (base64 или список ссылок)
  "xrayServers": [],                   // ИЛИ готовый список share-ссылок vless/vmess/trojan/ss

  "xraySubscriptionHeaders": {         // заголовки для запроса подписки
    "User-Agent": "v2rayTun/3.2.1",
    "Accept": "text/plain, */*;q=0.8"
  },

  // опционально:
  "siteRoot": "/var/www/jacksite"      // каталог с файлами сайта-оболочки
}
```

Поля:

| Поле | Описание |
|------|----------|
| `port` | Порт HTTP/WS сервера. |
| `host` | Публичный домен. Отдаётся в `GET /room` (`server`) и в ответах создания комнат. |
| `internalToken` | Секрет для админ-эндпоинтов `/admin/*` (`x-internal-token`). **Обязательно смените.** |
| `mitm.*` | Зеркалирование официального сервера (для отладки). Оставьте `enabled: false`. |
| `xrayBin` | Путь к бинарнику Xray. |
| `xrayLocalPort` | Локальный SOCKS5-порт Xray. |
| `xraySubscription` | URL подписки. Если задан — сервер сам скачает и распарсит серверы. |
| `xrayServers` | Массив share-ссылок, если подписки нет. |
| `xraySubscriptionHeaders` | Заголовки запроса подписки. |
| `siteRoot` | Корень сайта-оболочки (иначе `/var/www/jacksiteNEW` или `$SITE_ROOT`). |

---

## games.json

Содержит соответствие `appTag → appId` для игр:

```json
{
  "appTags": {
    "jackboxpartypack3": "...",
    "tmp3": "..."
  }
}
```

Используется, чтобы по `appTag` из запроса контроллера получить внутренний `appId`.
Если тег неизвестен — используется сам тег.

---

## Xray (обход гео-блокировок)

Клиент Jackbox и сервер обращаются к официальным серверам Jackbox для стриминга ассетов
и части логики. Если регион заблокирован, сервер поднимает **локальный Xray** и ходит
к апстримам через SOCKS5 (`127.0.0.1:10808`).

1. Скачайте Xray-core и положите бинарник, например, в `./xray-bin/xray`
   (и `geoip.dat` рядом, если нужен).
2. Укажите путь в `config.json` → `xrayBin`.
3. Задайте **любой из** вариантов:
   - `xraySubscription` — URL подписки;
   - `xrayServers` — массив share-ссылок (`vless://`, `vmess://`, `trojan://`, `ss://`).

При старте сервер сам запустит Xray, сгенерирует конфиг во временном файле и будет
использовать его для исходящих запросов. Статус можно посмотреть в
`GET /admin/xray/status`.

> Если Xray включён, но соединений нет — сервер продолжит работу: часть запросов
> пойдёт напрямую (`direct`).

---

## Запуск как сервис (pm2)

```bash
npm install -g pm2

pm2 start main.js --name frbox
pm2 save
pm2 startup          # чтобы автозапускать после перезагрузки
pm2 logs frbox       # логи
```

Сервер печатает в лог запросы по тегам `[ARCADE]`, `[BINJPIPE]`, `[MIXPANEL]`,
`[WS]`, `[ROOM]`, `[XRAY]` — удобно для диагностики.

---

## Nginx (reverse proxy + HTTPS)

Клиентам Jackbox нужен HTTPS/WSS, поэтому сервер прячется за nginx.
Вся логика пробросов (`/arc`, `/arcade`, `/binjpipe`, `/mixpanel`) уже внутри Node —
nginx нужен только как TLS-терминатор с поддержкой WebSocket.

В блок `http { }` добавьте:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Секция сервера:

```nginx
server {
    listen 80;
    server_name jack.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name jack.example.com;

    ssl_certificate     /etc/letsencrypt/live/jack.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jack.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3489;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        client_max_body_size 25m;
        proxy_request_buffering off;
    }
}
```

Получить сертификат:

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d jack.example.com
```

Проверить и перезапустить:

```bash
nginx -t
systemctl restart nginx
```

> Также позаботьтесь, чтобы `config.json` → `host` совпадал с `server_name`.

---

## Сайт-оболочка (контроллер)

Файлы контроллера (оболочка сайта Jackbox) **не входят в репозиторий**.
Разместите их в каталоге `siteRoot` (по умолчанию `/var/www/jacksiteNEW`).
Раздача статики зависит от домена (`Host`):
- на основном сервере (`CONFIG.host`, например `jack.*`) корень `/` — **панель FRbox** (`public/`);
- на остальных хостах (например `jpp.*`) корень `/` — **сайт-оболочка контроллера** (`siteRoot`).
Файлы панели и сайта всегда доступны и по прямым путям.

---

## Веб-дашборд и админ-API

После запуска:

- `/` — вход/дашборд (`public/index.html`),
- `/dashboard.html` — панель управления,
- `/room` — просмотр комнаты.

Регистрация: `POST /auth/register` (`username` ≥ 3, `password` ≥ 4), вход — `POST /auth/login`.
Данные пользователей хранятся в `data/users.json`, баны — в `data/bans.json`.

Админ-эндпоинты требуют заголовок `x-internal-token: <internalToken>`:

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/admin/rooms` | список комнат |
| GET | `/admin/stats` | статистика |
| GET | `/admin/bans` | список забаненных IP |
| POST | `/admin/ban-ip` | забанить IP |
| POST | `/admin/security/ban` `/unban` | управление банами |
| GET | `/admin/xray/status` | статус Xray |
| GET | `/admin/proxy-log` | лог прокси |
| GET/POST | `/admin/mitm` | режим зеркала |

---

## Прокси-эндпоинты

Сервер сам проксирует запросы к официальным сервисам Jackbox/аналитики:

| Префикс | Апстрим |
|---------|---------|
| `/arc/`, `/arcade/` | `https://api.jackboxgames.com` (`/arc/` → `/arcade/`) |
| `/binjpipe/` | `https://binjpipe.jackboxgames.com` |
| `/mixpanel/` | `https://api-js.mixpanel.com` |

Поддерживаются `OPTIONS`-preflight (CORS), проброс `X-JBG-*` заголовков и cookies.

---

## Решение проблем

- **Клиент не подключается** — проверьте, что сайт открывается по **HTTPS** и что
  `host` в `config.json` совпадает с доменом.
- **WebSocket рвётся** — убедитесь, что в nginx проброшены `Upgrade`/`Connection`
  и увеличены таймауты.
- **Нет связи с Xray** — проверьте `xrayBin`, порт `xrayLocalPort` и
  `GET /admin/xray/status`.
- **Не грузятся игры** — проверьте доступность апстримов (`/arcade/...`) и `games.json`.

---

## Лицензия

MIT — см. [LICENSE](LICENSE).

---

## Связь и сообщество

- Связь: https://t.me/error_kill (TG/DS)
- Все обновления и логи создания сервера можно видеть в чате русского комьюнити Jackbox: https://t.me/Jackbox_Pack_Chat

---

## Благодарности

Спасибо этим людям (Telegram):

- https://t.me/mazilofk
- https://t.me/CapringYT
- https://t.me/Loamfy
- https://t.me/sssssggggg1234
- https://t.me/FfGior — за вдохновение

Также сервер сильно вдохновлён и использует части кода таких серверов, как:

- FRbox (первой версии)
- klucva
- https://github.com/InvoxiPlayGames/johnbox
- https://github.com/StratusFearMe21/jonahbox

---

Простите, что я так плох в том, что делаю, но ГДЕ ПУБЛИЧНЫЙ КОД СОВРЕМЕННОГО СЕРВЕРА JACKBOX НА СЕГОДНЯШНЕЕ ВРЕМЯ??!
