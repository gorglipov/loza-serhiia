# Причина ADMIN_NOT_CONFIGURED у Preview PR №3

Перевірено 22 жовтня 2026 без зміни Cloudflare налаштувань і без виведення значень змінних.

## Точне місце

`server/access.js`, функція `settings(env)`. `authenticate()` викликає її **до** читання та перевірки JWT; `protectAdmin()` повертає її помилку з HTTP 503. Middleware для `/admin/*` і `/api/admin/*` передає саме `context.env`.

У попередньому коміті `25a72d0` перевірка домену вимагала повний HTTPS URL без кінцевого `/`. У фактичному Preview налаштовано коректний hostname команди **без схеми**. Цього достатньо, щоб згенерувати `ADMIN_NOT_CONFIGURED` навіть за наявності всіх чотирьох змінних. Це помилка надмірно суворого формату конфігурації, а не провал перевірки підпису JWT.

## Безпечні результати перевірки

| Поле / перевірка | Результат |
| --- | --- |
| ACCESS_TEAM_DOMAIN present | true |
| ACCESS_TEAM_DOMAIN strictFormatValid у старому коді | false |
| ACCESS_TEAM_DOMAIN bareHostnameFormatValid | true |
| ACCESS_TEAM_DOMAIN normalizedFormatValid після виправлення | true |
| ACCESS_AUD present | true |
| ACCESS_AUD formatValid (один AUD, 64 hex символи) | true |
| ACCESS_AUD matchesPreviewAccessLogin | true |
| ADMIN_EMAILS present | true |
| ADMIN_EMAILS formatValid | true |
| ADMIN_CSRF_SECRET present | true |
| previewDeploymentSuccessful | true |
| allFourBindingsPresentInDeploymentMetadata | true |
| normalizedTeamMatchesPreviewAccessLogin | true |
| accessJwksAvailable | true |
| accessRsaSigningKeysPresent | true |

Довжина/вміст зашифрованого `ADMIN_CSRF_SECRET` через API не читалися. Його формат перевіряє тільки сервер: непорожнє значення з мінімум 32 символами після відкидання зовнішніх пробілів. Runtime діагностика повертає лише булеві прапорці.

Список Access applications через доступний API виявився порожнім; це не використано як доказ неправильного AUD. AUD і домен звірені з фактичним офіційним Access redirect для `/admin` та `/api/admin/orders` у Preview. Реальний JWT авторизованої браузерної сесії не копіювався й не зчитувався. Повну авторизацію конкретного email потрібно завершити через штатну сторінку Access.

## Виправлення у PR №3

- Домен нормалізується до канонічного HTTPS issuer: підтримується hostname або HTTPS URL, зовнішні пробіли та один кінцевий `/`.
- Дозволений тільки домен команди Cloudflare Access. HTTP, сторонні домени, порт, userinfo та додаткові path/query/fragment заборонені. JWKS URL не береться з неперевірених JWT.
- Для AUD прибираються лише зовнішні пробіли. Залишається перевірка рівно 64 hex символів і точний збіг із підписаним `aud`.
- Помилка вказує назву проблемного поля та `present`/`formatValid`, без значень чи логування секретів.
- Тест відтворює hostname без HTTPS у bindings із правильним HTTPS `iss` у RSA-підписаному JWT; негативні тести підпису/AUD/email/CSRF залишаються.

Для початкової перевірки Access потрібні лише чотири перелічені змінні. Після успішної авторизації API адмінпанелі також використовує чинні `DB`, міграцію `0003_admin_telegram` і `CHECKOUT_SECURITY_KEY` для rate limit; їхні помилки не мають коду `ADMIN_NOT_CONFIGURED`. Telegram секрети не є умовою входу до адмінпанелі.

Перевірки виправлення: Pages Functions build успішний; 17/17 локальних сценаріїв пройшли, без пропусків. Інтеграційний Miniflare Preview використовує саме bare hostname у bindings та HTTPS issuer у підписаному JWT; також пройдено Edge 1440/390 px, CSRF, сторонній AUD/email, SQL/XSS і замовлення/Telegram.

## Що зробити

Дочекатися успішного **Preview deployment гілки `codex/admin-telegram` з виправленням**, відкрити стабільний URL гілки `/admin` і увійти штатним способом. Збережений hostname можна залишити. Альтернатива для старої збірки — дописати `https://` перед наявним hostname в **Preview** і знову розгорнути Preview. Production і Access policy змінювати не потрібно.
