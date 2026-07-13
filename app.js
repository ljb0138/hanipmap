const restaurants = [
  { id: 1, name: "성대 김밥", detail: "도보 3분 · 5,500원 · 간단한 한 끼", reason: "김밥과 라면 세트가 6,500원으로, 예산 안에서 가장 빠르게 먹기 좋아요." },
  { id: 2, name: "명륜국밥", detail: "도보 2분 · 8,000원 · 든든한 식사", reason: "캠퍼스에서 가장 가깝고 8,000원에 따뜻하고 든든한 식사가 가능해요." },
  { id: 3, name: "혜화분식", detail: "도보 4분 · 6,000원 · 빠른 식사", reason: "떡볶이와 김밥처럼 가볍게 먹을 메뉴가 많아 혼밥에도 잘 어울려요." }
];

const list = document.querySelector("#restaurants");
const reason = document.querySelector("#reason");

function selectRestaurant(id) {
  document.querySelectorAll(".restaurant").forEach((item) => item.classList.toggle("selected", Number(item.dataset.id) === id));
  document.querySelectorAll(".pin").forEach((pin) => pin.classList.toggle("active", Number(pin.dataset.id) === id));
  reason.textContent = restaurants.find((restaurant) => restaurant.id === id).reason;
}

function renderRestaurants() {
  list.innerHTML = restaurants.map((restaurant) => `
    <button class="restaurant" data-id="${restaurant.id}">
      <strong>${restaurant.name}</strong>
      <span>${restaurant.detail}</span>
    </button>
  `).join("");

  document.querySelectorAll(".restaurant").forEach((item) => item.addEventListener("click", () => selectRestaurant(Number(item.dataset.id))));
  selectRestaurant(1);
}

document.querySelectorAll(".pin").forEach((pin) => pin.addEventListener("click", () => selectRestaurant(Number(pin.dataset.id))));
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  document.querySelector("#query").value = chip.dataset.query;
  document.querySelectorAll(".chip").forEach((item) => item.classList.remove("active"));
  chip.classList.add("active");
}));
document.querySelector("#searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#resultTitle").textContent = "조건에 맞는 추천 3곳";
});

renderRestaurants();
