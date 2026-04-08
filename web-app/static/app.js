const state = {
  products: [],
  orders: [],
  workbook: '/download/product-orders.xls',
  expandedOrderId: ''
};

const elements = {
  form: document.getElementById('orderForm'),
  product: document.getElementById('product'),
  quantity: document.getElementById('quantity'),
  price: document.getElementById('price'),
  costTl: document.getElementById('costTl'),
  requestDescription: document.getElementById('requestDescription'),
  customerName: document.getElementById('customerName'),
  customerAddress: document.getElementById('customerAddress'),
  submitButton: document.getElementById('submitButton'),
  statusText: document.getElementById('statusText'),
  ordersTable: document.getElementById('ordersTable'),
  orderCount: document.getElementById('orderCount'),
  orderSum: document.getElementById('orderSum'),
  openCount: document.getElementById('openCount'),
  openSum: document.getElementById('openSum'),
  completedCount: document.getElementById('completedCount'),
  completedSum: document.getElementById('completedSum'),
  profitTotal: document.getElementById('profitTotal'),
  orderTotal: document.getElementById('orderTotal'),
  downloadLink: document.getElementById('downloadLink')
};

function formatMoney(value) {
  const amount = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));

  return `${amount} TL`;
}

function setStatus(message, type = '') {
  elements.statusText.textContent = message;
  elements.statusText.className = `status-text ${type}`.trim();
}

function isCompleted(order) {
  return String(order.status || '').toLowerCase() === 'completed';
}

function getOrderProfit(order) {
  if (Number.isFinite(Number(order.profitTl))) {
    return Number(order.profitTl || 0);
  }

  const quantity = Number(order.quantity || 0);
  const price = Number(order.price || 0);
  const costTl = Number(order.costTl || 0);
  return (price - costTl) * quantity;
}

function sortOrders(items) {
  return [...items].sort((left, right) => {
    const leftRank = isCompleted(left) ? 1 : 0;
    const rightRank = isCompleted(right) ? 1 : 0;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftDate = Date.parse(left.openedAt || left.createdAt || '') || 0;
    const rightDate = Date.parse(right.openedAt || right.createdAt || '') || 0;
    return rightDate - leftDate;
  });
}

function updateSummaryMetrics() {
  const openOrders = state.orders.filter((order) => !isCompleted(order));
  const completedOrders = state.orders.filter((order) => isCompleted(order));
  const sum = (items) => items.reduce((total, item) => total + Number(item.total || 0), 0);
  const profit = (items) => items.reduce((total, item) => total + getOrderProfit(item), 0);

  elements.orderCount.textContent = String(state.orders.length);
  elements.orderSum.textContent = formatMoney(sum(state.orders));
  elements.openCount.textContent = String(openOrders.length);
  elements.openSum.textContent = formatMoney(sum(openOrders));
  elements.completedCount.textContent = String(completedOrders.length);
  elements.completedSum.textContent = formatMoney(sum(completedOrders));
  elements.profitTotal.textContent = formatMoney(profit(state.orders));
}

function updateComputedTotal() {
  const quantity = Number(elements.quantity.value || 0);
  const price = Number(elements.price.value || 0);
  elements.orderTotal.textContent = formatMoney(quantity * price);
}

function fillProductOptions(products) {
  elements.product.innerHTML = '<option value="">Выберите продукт</option>';

  products.forEach((product) => {
    const option = document.createElement('option');
    option.value = product.name;
    option.textContent = product.name;
    elements.product.append(option);
  });
}

function renderOrders() {
  state.orders = sortOrders(state.orders);
  updateSummaryMetrics();

  if (!state.orders.length) {
    elements.ordersTable.innerHTML = `
      <tr>
        <td colspan="10" class="empty-cell">Заказов пока нет</td>
      </tr>
    `;
    return;
  }

  elements.ordersTable.innerHTML = state.orders.map((order) => {
    const isExpanded = state.expandedOrderId === order.orderId;

    return `
      <tr class="order-row ${isCompleted(order) ? 'is-completed' : ''} ${isExpanded ? 'is-expanded' : ''}" data-order-id="${order.orderId}">
        <td>${order.orderId}</td>
        <td>${order.product}</td>
        <td>${order.quantity}</td>
        <td>${formatMoney(order.price)}</td>
        <td>${formatMoney(order.costTl)}</td>
        <td>${formatMoney(order.total)}</td>
        <td>${order.customerName}</td>
        <td>${order.openedAt || order.createdAt || ''}</td>
        <td><span class="status-pill ${isCompleted(order) ? 'completed' : 'open'}">${isCompleted(order) ? 'Выполнен' : 'Открыт'}</span></td>
        <td>
          <div class="row-actions">
            ${isCompleted(order) ? '' : `<button type="button" class="table-button complete-order-button success" data-order-id="${order.orderId}">Выполнить</button>`}
            <button type="button" class="table-button delete-order-button cancel" data-order-id="${order.orderId}">Удалить</button>
          </div>
        </td>
      </tr>
      ${isExpanded ? `
        <tr class="order-details-row">
          <td colspan="10" class="order-details-cell">
            <div class="order-details">
              <div>
                <span class="details-label">Описание заказа</span>
                <p>${order.requestDescription || 'Не указано'}</p>
              </div>
              <div>
                <span class="details-label">Адрес заказчика</span>
                <p>${order.customerAddress || 'Не указан'}</p>
              </div>
            </div>
          </td>
        </tr>
      ` : ''}
    `;
  }).join('');

  elements.ordersTable.querySelectorAll('.order-row').forEach((row) => {
    row.addEventListener('click', () => toggleOrderDetails(row.dataset.orderId));
  });

  elements.ordersTable.querySelectorAll('.complete-order-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      completeOrder(button.dataset.orderId);
    });
  });

  elements.ordersTable.querySelectorAll('.delete-order-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      cancelOrder(button.dataset.orderId);
    });
  });
}

function toggleOrderDetails(orderId) {
  state.expandedOrderId = state.expandedOrderId === orderId ? '' : orderId;
  renderOrders();
}

async function loadProducts() {
  const response = await fetch('/api/products');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Не удалось загрузить список продуктов.');
  }

  state.products = payload.items || [];
  fillProductOptions(state.products);
}

async function loadOrders() {
  const response = await fetch('/api/orders');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Не удалось загрузить список заказов.');
  }

  state.orders = payload.items || [];
  state.workbook = payload.workbook || state.workbook;
  elements.downloadLink.href = state.workbook;
  renderOrders();
}

async function completeOrder(orderId) {
  setStatus('');

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/complete`, {
      method: 'POST'
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Не удалось завершить заказ.');
    }

    state.orders = state.orders.map((order) => (
      order.orderId === result.item.orderId ? result.item : order
    ));
    state.workbook = result.workbook || state.workbook;
    elements.downloadLink.href = state.workbook;
    renderOrders();
    setStatus('Заказ отмечен как выполненный.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function cancelOrder(orderId) {
  setStatus('');

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST'
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Не удалось отменить заказ.');
    }

    state.orders = state.orders.filter((order) => order.orderId !== orderId);
    if (state.expandedOrderId === orderId) {
      state.expandedOrderId = '';
    }
    state.workbook = result.workbook || state.workbook;
    elements.downloadLink.href = state.workbook;
    renderOrders();
    setStatus('Заказ удален из списка.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function submitOrder(event) {
  event.preventDefault();
  setStatus('');

  const payload = {
    product: elements.product.value,
    quantity: Number(elements.quantity.value || 0),
    price: Number(elements.price.value || 0),
    costTl: Number(elements.costTl.value || 0),
    requestDescription: elements.requestDescription.value.trim(),
    customerName: elements.customerName.value.trim(),
    customerAddress: elements.customerAddress.value.trim()
  };

  elements.submitButton.disabled = true;

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Не удалось сохранить заказ.');
    }

    state.orders = [result.item, ...state.orders];
    state.expandedOrderId = result.item.orderId;
    state.workbook = result.workbook || state.workbook;
    elements.downloadLink.href = state.workbook;
    renderOrders();

    elements.form.reset();
    elements.quantity.value = '1';
    elements.costTl.value = '0.00';
    updateComputedTotal();
    setStatus('Заказ сохранен.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    elements.submitButton.disabled = false;
  }
}

async function initialize() {
  updateComputedTotal();

  elements.quantity.addEventListener('input', updateComputedTotal);
  elements.price.addEventListener('input', updateComputedTotal);
  elements.form.addEventListener('submit', submitOrder);

  try {
    await Promise.all([loadProducts(), loadOrders()]);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

initialize();
