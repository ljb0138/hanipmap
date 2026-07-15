const CAMPUS = { lat: 37.5856, lng: 126.9897 };

const restaurants = [
  {
    id: 1, name: "성대 김밥", walkMinutes: 3, typicalPrice: 6500,
    tags: ["lonely", "budget10k", "walk5"],
    menu: [{ name: "김밥", price: 2500 }, { name: "라면", price: 3500 }, { name: "떡볶이", price: 3000 }, { name: "순대", price: 2500 }],
    hours: { open: "08:00", close: "21:00" },
    baseReason: "김밥과 라면 세트가 6,500원으로, 예산 안에서 가장 빠르게 먹기 좋아요.",
    latlng: { lat: 37.5854, lng: 126.9888 },
    searchKeyword: "성균관대 분식"
  },
  {
    id: 2, name: "명륜국밥", walkMinutes: 2, typicalPrice: 8000,
    tags: ["lonely", "budget10k", "hangover", "exam247"],
    menu: [{ name: "순대국밥 특", price: 7000 }, { name: "공기밥", price: 1000 }, { name: "수육 소", price: 9000 }, { name: "계란찜", price: 3000 }],
    hours: { is24h: true },
    baseReason: "캠퍼스에서 가장 가깝고 8,000원에 따뜻하고 든든한 식사가 가능해요.",
    latlng: { lat: 37.5862, lng: 126.9902 },
    searchKeyword: "성균관대 국밥"
  },
  {
    id: 3, name: "혜화분식", walkMinutes: 4, typicalPrice: 6000,
    tags: ["lonely", "budget10k", "walk5"],
    menu: [{ name: "떡볶이", price: 3000 }, { name: "김밥", price: 2500 }, { name: "순대", price: 2500 }, { name: "튀김", price: 1500 }],
    hours: { open: "10:00", close: "20:00" },
    baseReason: "떡볶이와 김밥처럼 가볍게 먹을 메뉴가 많아 혼밥에도 잘 어울려요.",
    latlng: { lat: 37.5845, lng: 126.9908 },
    searchKeyword: "혜화동 분식"
  },
  {
    id: 4, name: "새벽감성 스터디카페", walkMinutes: 6, typicalPrice: 4500,
    tags: ["exam247"],
    menu: [{ name: "아메리카노", price: 2500 }, { name: "샌드위치", price: 4500 }, { name: "크루아상", price: 3000 }],
    hours: { is24h: true },
    baseReason: "24시간 콘센트 좌석이 넉넉해 시험기간 밤샘 공부하기 좋아요.",
    latlng: { lat: 37.5840, lng: 126.9881 },
    searchKeyword: "성균관대 스터디카페"
  },
  {
    id: 5, name: "명륜 파스타하우스", walkMinutes: 7, typicalPrice: 18000,
    tags: ["formal"],
    menu: [{ name: "토마토파스타", price: 13000 }, { name: "크림파스타", price: 14000 }, { name: "샐러드", price: 6000 }, { name: "스테이크 세트", price: 28000 }],
    hours: { open: "11:00", close: "21:00", breakStart: "15:00", breakEnd: "17:00" },
    baseReason: "분위기가 차분해 교수님이나 어른과 격식 있게 식사하기 좋아요.",
    latlng: { lat: 37.5867, lng: 126.9917 },
    searchKeyword: "혜화동 파스타"
  },
  {
    id: 6, name: "성대한우마당", walkMinutes: 9, typicalPrice: 35000,
    tags: ["splurge"],
    menu: [{ name: "한우모둠", price: 35000 }, { name: "된장찌개", price: 8000 }, { name: "냉면", price: 9000 }],
    hours: { open: "12:00", close: "23:00" },
    baseReason: "과선배가 쏘는 날 부담 없이 고급스럽게 먹기 좋은 곳이에요.",
    latlng: { lat: 37.5834, lng: 126.9896 },
    searchKeyword: "성균관대 고기집"
  }
];

const LS_RECENT = "hanipmap_recent_searches";
const LS_DEFAULT = "hanipmap_default_query";

const queryInput = document.querySelector("#query");
const searchForm = document.querySelector("#searchForm");
const resultTitle = document.querySelector("#resultTitle");
const list = document.querySelector("#restaurants");
const reason = document.querySelector("#reason");
const recentContainer = document.querySelector("#recentSearches");
const saveDefaultBtn = document.querySelector("#saveDefaultBtn");
const defaultSearchBtn = document.querySelector("#defaultSearchBtn");
const shuffleBtn = document.querySelector("#shuffleBtn");

const map = new naver.maps.Map("map", {
  center: new naver.maps.LatLng(CAMPUS.lat, CAMPUS.lng),
  zoom: 16
});

new naver.maps.Marker({
  position: new naver.maps.LatLng(CAMPUS.lat, CAMPUS.lng),
  map,
  icon: { content: '<div class="campus-marker">성균관대학교 명륜캠퍼스</div>', anchor: new naver.maps.Point(60, 20) }
});

const markers = new Map();

let activeTag = null;
let currentList = restaurants;
let selectedId = null;

function parseBudget(text) {
  let match = text.match(/(\d+)\s*천\s*원/);
  if (match) return Number(match[1]) * 1000;
  match = text.match(/(\d+)\s*만\s*원/);
  if (match) return Number(match[1]) * 10000;
  match = text.match(/(\d+)\s*원/);
  if (match) return Number(match[1]);
  return null;
}

function parseWalkMax(text) {
  let match = text.match(/도보\s*(\d+)\s*분/);
  if (match) return Number(match[1]);
  match = text.match(/(\d+)\s*m\s*이내/);
  if (match) return Math.ceil(Number(match[1]) / 80);
  return null;
}

function bestCombo(menu, budget) {
  let best = null;
  const n = menu.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const items = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { items.push(menu[i]); total += menu[i].price; }
    }
    if (total <= budget && (!best || total > best.total)) best = { items, total };
  }
  return best;
}

function reasonFor(restaurant, budget) {
  if (!budget) return restaurant.baseReason;
  const combo = bestCombo(restaurant.menu, budget);
  if (!combo) return "예산 안에서는 메뉴 조합을 찾기 어려워요. 예산을 조금 늘려보세요.";
  if (combo.items.length === 1) {
    return `'${combo.items[0].name}' 하나로 ${combo.total.toLocaleString()}원에 먹을 수 있어요.`;
  }
  const [first, ...rest] = combo.items;
  const restNames = rest.map((item) => `'${item.name}'`).join(", ");
  return `'${first.name}'에 ${restNames} 추가하면 ${combo.total.toLocaleString()}원으로 예산에 딱 맞아요.`;
}

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function hoursStatus(hours, now = new Date()) {
  if (hours.is24h) return { label: "24시간 영업", state: "open" };
  const cur = now.getHours() * 60 + now.getMinutes();
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  const inRange = open < close ? (cur >= open && cur < close) : (cur >= open || cur < close);
  if (!inRange) return { label: "영업종료", state: "closed" };
  if (hours.breakStart && hours.breakEnd) {
    const breakStart = toMinutes(hours.breakStart);
    const breakEnd = toMinutes(hours.breakEnd);
    if (cur >= breakStart && cur < breakEnd) {
      return { label: `브레이크타임 · ${hours.breakStart}~${hours.breakEnd}`, state: "break" };
    }
  }
  return { label: `영업중 · ${hours.close}까지`, state: "open" };
}

function matchesFilters(restaurant, { budget, walkMax, tag }) {
  if (budget) {
    const cheapest = Math.min(...restaurant.menu.map((item) => item.price));
    if (cheapest > budget) return false;
  }
  if (walkMax && restaurant.walkMinutes > walkMax) return false;
  if (tag && !restaurant.tags.includes(tag)) return false;
  if (hoursStatus(restaurant.hours).state !== "open") return false;
  return true;
}

async function fetchRealPlace(keyword) {
  try {
    const res = await fetch(`/api/search?query=${encodeURIComponent(keyword)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item) return null;
    return {
      name: item.title.replace(/<\/?b>/g, ""),
      address: (item.roadAddress || item.address || "").trim(),
      latlng: { lat: Number(item.mapy) / 1e7, lng: Number(item.mapx) / 1e7 }
    };
  } catch {
    return null;
  }
}

async function hydrateRealPlaces() {
  await Promise.all(restaurants.map(async (restaurant) => {
    if (!restaurant.searchKeyword) return;
    const real = await fetchRealPlace(restaurant.searchKeyword);
    if (real) Object.assign(restaurant, real);
  }));
}

function pinIcon({ active = false, hover = false } = {}) {
  const cls = ["pin", active && "active", hover && "hover-focus"].filter(Boolean).join(" ");
  return { content: `<div class="${cls}"></div>`, size: new naver.maps.Size(36, 36), anchor: new naver.maps.Point(18, 36) };
}

function setHoverMarker(id, hover) {
  const marker = markers.get(id);
  if (marker) marker.setIcon(pinIcon({ active: id === selectedId, hover }));
}

function updateMarkerStates() {
  markers.forEach((marker, id) => marker.setIcon(pinIcon({ active: id === selectedId })));
}

function renderMarkers(restaurantList) {
  markers.forEach((marker) => marker.setMap(null));
  markers.clear();

  restaurantList.forEach((restaurant) => {
    const marker = new naver.maps.Marker({
      position: new naver.maps.LatLng(restaurant.latlng.lat, restaurant.latlng.lng),
      map,
      title: restaurant.name,
      icon: pinIcon()
    });
    naver.maps.Event.addListener(marker, "click", () => selectRestaurant(restaurant.id));
    naver.maps.Event.addListener(marker, "mouseover", () => setHoverMarker(restaurant.id, true));
    naver.maps.Event.addListener(marker, "mouseout", () => setHoverMarker(restaurant.id, false));
    markers.set(restaurant.id, marker);
  });
}

function renderRestaurants(restaurantList, budget) {
  if (restaurantList.length === 0) {
    list.innerHTML = `<p class="empty">조건에 맞는 식당이 없어요. 조건을 조금 완화해보세요.</p>`;
    reason.textContent = "";
    return;
  }

  list.innerHTML = restaurantList.map((restaurant) => {
    const status = hoursStatus(restaurant.hours);
    return `
    <button class="restaurant" data-id="${restaurant.id}">
      <div class="restaurant-head">
        <strong>${restaurant.name}</strong>
        <span class="status ${status.state}">${status.label}</span>
      </div>
      <span>도보 ${restaurant.walkMinutes}분 · ${restaurant.typicalPrice.toLocaleString()}원</span>
      ${restaurant.address ? `<span class="address">${restaurant.address}</span>` : ""}
    </button>
  `;
  }).join("");

  list.querySelectorAll(".restaurant").forEach((item) => {
    const id = Number(item.dataset.id);
    item.addEventListener("click", () => selectRestaurant(id));
    item.addEventListener("mouseenter", () => setHoverMarker(id, true));
    item.addEventListener("mouseleave", () => setHoverMarker(id, false));
  });

  const hasSelected = restaurantList.some((restaurant) => restaurant.id === selectedId);
  selectRestaurant(hasSelected ? selectedId : restaurantList[0].id, budget);
}

function selectRestaurant(id, budget = parseBudget(queryInput.value)) {
  selectedId = id;
  list.querySelectorAll(".restaurant").forEach((item) => item.classList.toggle("selected", Number(item.dataset.id) === id));
  updateMarkerStates();
  const restaurant = currentList.find((item) => item.id === id) || restaurants.find((item) => item.id === id);
  reason.textContent = reasonFor(restaurant, budget);
  const marker = markers.get(id);
  if (marker) map.panTo(marker.getPosition());
}

function runSearch({ recordRecent = false } = {}) {
  const text = queryInput.value;
  const budget = parseBudget(text);
  const walkMax = parseWalkMax(text);

  currentList = restaurants
    .filter((restaurant) => matchesFilters(restaurant, { budget, walkMax, tag: activeTag }))
    .sort((a, b) => a.walkMinutes - b.walkMinutes);

  resultTitle.textContent = currentList.length ? `추천 ${currentList.length}곳` : "추천 결과 없음";
  renderMarkers(currentList);
  renderRestaurants(currentList, budget);

  if (recordRecent && text.trim()) pushRecentSearch(text.trim());
}

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT)) || []; } catch { return []; }
}

function pushRecentSearch(query) {
  const updated = [query, ...getRecentSearches().filter((item) => item !== query)].slice(0, 5);
  localStorage.setItem(LS_RECENT, JSON.stringify(updated));
  renderRecentSearches();
}

function renderRecentSearches() {
  const recent = getRecentSearches();
  recentContainer.innerHTML = recent.map((query) => `<button class="recent-chip">${query}</button>`).join("");
  recentContainer.querySelectorAll(".recent-chip").forEach((chip) => chip.addEventListener("click", () => {
    queryInput.value = chip.textContent;
    runSearch({ recordRecent: true });
  }));
}

function renderDefaultButton() {
  const saved = localStorage.getItem(LS_DEFAULT);
  defaultSearchBtn.hidden = !saved;
}

saveDefaultBtn.addEventListener("click", () => {
  localStorage.setItem(LS_DEFAULT, queryInput.value);
  renderDefaultButton();
});

defaultSearchBtn.addEventListener("click", () => {
  const saved = localStorage.getItem(LS_DEFAULT);
  if (!saved) return;
  queryInput.value = saved;
  runSearch({ recordRecent: true });
});

shuffleBtn.addEventListener("click", () => {
  const pool = currentList.length ? currentList : restaurants;
  let ticks = 0;
  const timer = setInterval(() => {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    selectRestaurant(pick.id);
    ticks++;
    if (ticks >= 6) {
      clearInterval(timer);
      const finalPick = pool[Math.floor(Math.random() * pool.length)];
      selectRestaurant(finalPick.id);
    }
  }, 90);
});

document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  const tag = chip.dataset.tag;
  const turningOn = activeTag !== tag;
  activeTag = turningOn ? tag : null;
  document.querySelectorAll(".chip").forEach((item) => item.classList.remove("active"));
  if (turningOn) {
    chip.classList.add("active");
    queryInput.value = chip.dataset.query;
  }
  runSearch({ recordRecent: true });
}));

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch({ recordRecent: true });
});

renderRecentSearches();
renderDefaultButton();
runSearch();

hydrateRealPlaces().then(() => runSearch());
