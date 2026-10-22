
export function onRequestGet() {
  const html = `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Оформлення замовлення | LOZA</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f5f2;
      padding: 24px;
    }
    .card {
      max-width: 420px;
      margin: 40px auto;
      background: white;
      padding: 28px;
      border-radius: 16px;
      box-shadow: 0 4px 20px #0001;
    }
    input, button {
      box-sizing: border-box;
      width: 100%;
      padding: 14px;
      margin: 10px 0;
      font-size: 16px;
      border-radius: 8px;
    }
    input { border: 1px solid #ccc; }
    button {
      background: #245c39;
      color: white;
      border: none;
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; }
    #result { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="card">
    <h2>LOZA — замовлення</h2>
    <p>Виноград (тестовий товар)</p>
    <h2>500 грн / шт.</h2>

    <form id="orderForm">
      <label for="qty">Кількість:</label>
      <input id="qty" type="number"
             min="1" max="5" value="1" required>

      <button id="orderButton" type="submit">
        Оформити замовлення
      </button>
    </form>

    <p id="result" role="status"></p>
    <small>Тестовий режим. Реальної оплати немає.</small>
  </div>

  <script>
    const form = document.getElementById("orderForm");
    const result = document.getElementById("result");
    const button = document.getElementById("orderButton");

    form.addEventListener("submit", async function(event) {
      event.preventDefault();

      const quantity = Number(
        document.getElementById("qty").value
      );

      button.disabled = true;
      result.textContent = "Створюємо замовлення...";

      try {
        const response = await fetch("/api/orders/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            product: "grape-demo",
            quantity: quantity
          })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error("Не вдалося створити замовлення");
        }

        result.textContent =
          "Замовлення: " + data.orderId +
          " | Сума: " + data.amount + " грн" +
          " | Статус: очікує оплати (тест)";

      } catch (error) {
        result.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
