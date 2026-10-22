export const adminHtml=`<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LOZA · Керування магазином</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body><aside class="sidebar"><a class="brand" href="/admin">LOZA<span>керування магазином</span></a>
<nav aria-label="Розділи"><button data-view="dashboard" aria-current="page">Огляд</button><button data-view="products">Товари</button><button data-view="orders">Замовлення</button><button data-view="audit">Історія змін</button><button data-view="telegram">Telegram</button></nav>
<div class="sidebar-bottom"><p id="identity">Перевірка доступу…</p><a href="/">↗ Відкрити магазин</a><a href="/cdn-cgi/access/logout">Вийти</a></div></aside>
<main><header><div><p class="eyebrow">МАЙСТЕРНЯ ВИНОГРАДАРЯ</p><h1 id="pageTitle">Огляд магазину</h1><p class="muted">Товари, замовлення та щоденна робота LOZA.</p></div><span class="mode">Платежі вимкнені</span></header>
<div id="notice" role="status" aria-live="polite" hidden></div><section id="content" aria-busy="true"><p>Завантаження…</p></section>
</main><dialog id="editor"><header><h2 id="editorTitle">Редагування</h2><button id="closeEditor" type="button" aria-label="Закрити">✕</button></header><div id="editorBody"></div></dialog>
</body></html>`;
