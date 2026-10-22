// This card uses only the test product supported by /api/orders/create.
(() => {
  "use strict";

  const card = document.getElementById("demoOrderCard");
  if (!card) return;

  const form = card.querySelector("form");
  const fields = card.querySelector("fieldset");
  const quantity = card.querySelector("select");
  const total = card.querySelector("output");
  const button = card.querySelector('[type="submit"]');
  const feedback = card.querySelector('[role="status"]');
  const success = document.getElementById("demoOrderSuccess");
  const another = document.getElementById("demoOrderAnother");
  const money = new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH", maximumFractionDigits: 2 });
  const storageKey = "loza-demo-order-pending-v1";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let inFlight = false;
  let completed = false;
  let pending = null;

  const validQuantity = value => Number.isInteger(value) && value >= 1 && value <= 5;
  const makeKey = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  };
  const setFeedback = (text, tone = "") => {
    feedback.textContent = text;
    feedback.dataset.tone = tone;
  };
  const savePending = () => {
    try {
      if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Ordering still works when browser storage is unavailable. */ }
  };
  const updateTotal = () => {
    // Display estimate only. The API calculates and stores the authoritative amount.
    total.value = money.format(500 * Number(quantity.value));
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && uuid.test(saved.key) && validQuantity(saved.quantity)) {
      pending = { key: saved.key.toLowerCase(), quantity: saved.quantity };
      quantity.value = String(pending.quantity);
      quantity.disabled = true;
      button.textContent = "Повторити запит";
      setFeedback("Попередній запит ще не підтверджено. Повторіть його, щоб отримати те саме замовлення.");
    }
  } catch { /* Ignore unavailable storage or invalid saved data. */ }

  quantity.addEventListener("change", updateTotal);
  updateTotal();
  // Enabled only after handlers are installed; the form cannot accidentally navigate.
  button.disabled = false;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (inFlight || completed) return;

    const count = pending ? pending.quantity : Number(quantity.value);
    if (!validQuantity(count)) {
      setFeedback("Оберіть кількість від 1 до 5.", "error");
      quantity.focus();
      return;
    }
    if (!navigator.onLine) {
      setFeedback("Немає інтернету. Перевірте з’єднання та повторіть спробу.", "error");
      return;
    }

    inFlight = true;
    fields.disabled = true;
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    button.textContent = "Створюємо замовлення…";
    setFeedback("Очікуємо підтвердження сервера…");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      pending ||= { key: makeKey(), quantity: count };
      savePending();
      const response = await fetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        // No price, amount, status, bank details or secrets are sent from the browser.
        body: JSON.stringify({ product: "grape-demo", quantity: pending.quantity }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 400 || response.status === 415) {
          pending = null;
          savePending();
          throw new Error("Не вдалося прийняти дані. Оберіть кількість від 1 до 5 та повторіть спробу.");
        }
        if (response.status === 503) {
          throw new Error("Тестове оформлення тимчасово недоступне. Спробуйте пізніше або зверніться до підтримки.");
        }
        if (response.status === 409) {
          pending = null;
          savePending();
          throw new Error("Попередній запит містить іншу кількість. Оберіть потрібну кількість і повторіть спробу.");
        }
        throw new Error("Не вдалося отримати підтвердження. Повторіть запит: повторна спроба використає той самий номер замовлення.");
      }

      if (!data?.success || typeof data.orderId !== "string" ||
          data.orderId !== "TEST-" + pending.key ||
          typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount <= 0 ||
          data.currency !== "UAH" || data.status !== "pending" || data.testOnly !== true) {
        throw new Error("Сервер повернув незрозумілу відповідь. Повторіть запит, щоб отримати підтвердження цього замовлення.");
      }

      document.getElementById("demoOrderNumber").textContent = data.orderId;
      document.getElementById("demoOrderAmount").textContent = money.format(data.amount);
      document.getElementById("demoOrderStatus").textContent = data.status + " — очікує";
      completed = true;
      pending = null;
      savePending();
      form.hidden = true;
      success.hidden = false;
      setFeedback("Тестове замовлення створено. Реальна оплата не потрібна.");
      success.querySelector("h4").focus();
    } catch (error) {
      const message = error.name === "AbortError" || error instanceof TypeError
        ? "Зв’язок із сервером перервався. Повторіть запит: використаємо той самий номер, щоб не створити замовлення двічі."
        : error.message || "Не вдалося створити замовлення. Повторіть спробу.";
      setFeedback(message, "error");
    } finally {
      clearTimeout(timeout);
      inFlight = false;
      fields.disabled = false;
      quantity.disabled = Boolean(pending);
      button.disabled = completed;
      button.textContent = pending ? "Повторити запит" : "Купити";
      form.removeAttribute("aria-busy");
    }
  });

  another.addEventListener("click", () => {
    if (inFlight) return;
    completed = false;
    pending = null;
    savePending();
    quantity.value = "1";
    quantity.disabled = false;
    button.disabled = false;
    button.textContent = "Купити";
    form.hidden = false;
    success.hidden = true;
    setFeedback("");
    updateTotal();
    quantity.focus();
  });
})();
