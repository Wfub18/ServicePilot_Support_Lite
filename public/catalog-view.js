(function () {
  const catalog = globalThis.ServicePilotCatalog;
  const packages = document.querySelector("#catalog-packages");
  const common = document.querySelector("#catalog-common");
  document.querySelector("#catalog-notice").textContent =
    `${catalog.notice} ${catalog.title} v${catalog.version} от ${catalog.date}. ${catalog.scope}.`;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  for (const plan of catalog.packages) {
    const card = element("article", "", "catalog-card");
    card.append(element("h3", plan.name), element("p", plan.price, "catalog-price"),
      element("p", plan.eligibility), element("p", `Минимальный договор — ${plan.minimumMonths} мес.`),
      element("p", `Поддержка: ${plan.support}`));
    const details = element("details", "");
    details.append(element("summary", "SLA и состав пакета"));
    for (const [priority, reaction] of Object.entries(plan.reaction)) {
      details.append(element("p", `Реакция ${priority}: ${reaction}.`));
    }
    for (const field of ["visits", "emergency", "monitoring", "reporting", "launch"]) {
      if (plan[field]) details.append(element("p", plan[field]));
    }
    details.append(element("p", `Дополнительный пользователь сверх лимита — ${plan.extraUserRub} ₽/мес.`));
    card.append(details);
    packages.append(card);
  }
  for (const text of Object.values(catalog.common)) common.append(element("p", text));
})();
