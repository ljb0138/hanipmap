const CAMPUS = { lat: 37.5856, lng: 126.9897 };

const SUPABASE_URL = "https://ubvpkldnsadyxnhirjzl.supabase.co";
const SUPABASE_KEY = "sb_publishable_bYQBH_FnrYBanG9YufSkBQ_0qPY0nG1";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let restaurants = [];

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
let currentList = [];
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
  if (!restaurant.menu.length) return restaurant.baseReason || "아직 메뉴·가격 정보가 없어요. 방문 후기나 제보를 기다리고 있어요!";
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
  if (!hours.open || !hours.close) return { label: "영업시간 정보 없음", state: "unknown" };
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
  if (budget && restaurant.menu.length) {
    const cheapest = Math.min(...restaurant.menu.map((item) => item.price));
    if (cheapest > budget) return false;
  }
  if (walkMax && restaurant.walkMinutes && restaurant.walkMinutes > walkMax) return false;
  if (tag && !restaurant.tags.includes(tag)) return false;
  const state = hoursStatus(restaurant.hours).state;
  if (state === "closed" || state === "break") return false;
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

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address || "",
    walkMinutes: row.walk_minutes,
    typicalPrice: row.typical_price,
    tags: row.tags || [],
    menu: row.menu || [],
    hours: row.hours || {},
    baseReason: row.base_reason || "",
    latlng: { lat: row.lat, lng: row.lng }
  };
}

async function loadRestaurants() {
  const { data, error } = await supabaseClient
    .from("restaurants")
    .select("*")
    .eq("status", "approved")
    .order("walk_minutes", { ascending: true });
  if (error) {
    console.error("failed to load restaurants", error);
    return [];
  }
  return data.map(mapRow);
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
    const walkText = restaurant.walkMinutes ? `도보 ${restaurant.walkMinutes}분` : "";
    const priceText = restaurant.typicalPrice ? `${restaurant.typicalPrice.toLocaleString()}원` : "가격 정보 없음";
    const detailText = [walkText, priceText].filter(Boolean).join(" · ");
    return `
    <button class="restaurant" data-id="${restaurant.id}">
      <div class="restaurant-head">
        <strong>${restaurant.name}</strong>
        <span class="status ${status.state}">${status.label}</span>
      </div>
      <span>${detailText}</span>
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

const toggleSubmitForm = document.querySelector("#toggleSubmitForm");
const submitForm = document.querySelector("#submitForm");
const lookupAddressBtn = document.querySelector("#lookupAddressBtn");
const subName = document.querySelector("#subName");
const subAddressPreview = document.querySelector("#subAddressPreview");
const subMenu = document.querySelector("#subMenu");
const subWalkMinutes = document.querySelector("#subWalkMinutes");
const subTypicalPrice = document.querySelector("#subTypicalPrice");
const subIs24h = document.querySelector("#subIs24h");
const subOpen = document.querySelector("#subOpen");
const subClose = document.querySelector("#subClose");
const subReason = document.querySelector("#subReason");
const subSubmittedBy = document.querySelector("#subSubmittedBy");
const submitStatus = document.querySelector("#submitStatus");

let foundPlace = null;

function parseMenuText(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, price] = line.split(":").map((part) => part.trim());
    return { name, price: Number(price) || 0 };
  }).filter((item) => item.name);
}

toggleSubmitForm.addEventListener("click", () => {
  const isHidden = submitForm.hidden;
  submitForm.hidden = !isHidden;
  toggleSubmitForm.textContent = isHidden ? "− 제보 폼 닫기" : "+ 우리 학교 맛집 제보하기";
});

lookupAddressBtn.addEventListener("click", async () => {
  const name = subName.value.trim();
  if (!name) return;
  subAddressPreview.textContent = "검색 중...";
  const place = await fetchRealPlace(name);
  if (!place) {
    foundPlace = null;
    subAddressPreview.textContent = "주소를 찾을 수 없어요. 더 정확한 이름으로 다시 시도해주세요.";
    return;
  }
  foundPlace = place;
  subAddressPreview.textContent = `${place.name} · ${place.address}`;
});

submitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!foundPlace) {
    submitStatus.textContent = "먼저 '주소 찾기'로 실제 위치를 확인해주세요.";
    return;
  }

  const tags = [...submitForm.querySelectorAll(".tag-checks input:checked")].map((el) => el.value);
  const hours = subIs24h.checked
    ? { is24h: true }
    : { open: subOpen.value, close: subClose.value };

  submitStatus.textContent = "제보 등록 중...";
  const { error } = await supabaseClient.from("restaurants").insert({
    name: foundPlace.name,
    address: foundPlace.address,
    lat: foundPlace.latlng.lat,
    lng: foundPlace.latlng.lng,
    walk_minutes: Number(subWalkMinutes.value) || null,
    typical_price: Number(subTypicalPrice.value) || null,
    tags,
    menu: parseMenuText(subMenu.value),
    hours,
    base_reason: subReason.value.trim() || null,
    submitted_by: subSubmittedBy.value.trim() || null,
    status: "pending"
  });

  if (error) {
    submitStatus.textContent = "제보에 실패했어요. 잠시 후 다시 시도해주세요.";
    return;
  }
  submitStatus.textContent = "제보 감사합니다! 검토 후 목록에 반영돼요.";
  submitForm.reset();
  foundPlace = null;
  subAddressPreview.textContent = "";
});

renderRecentSearches();
renderDefaultButton();

(async function init() {
  resultTitle.textContent = "불러오는 중...";
  restaurants = await loadRestaurants();
  runSearch();
})();
