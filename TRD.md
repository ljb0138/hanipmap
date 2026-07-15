# 한입지도 TRD (Technical Requirements Document)

## 1. 개요

**한입지도**는 성균관대학교 명륜캠퍼스 주변 맛집을, 사용자가 처한 "상황"(예산, 거리, 시험기간, 해장, 격식 있는 자리 등)에 맞춰 자연어 조건으로 추천해주는 웹 서비스다.

- **타겟 사용자**: 성균관대 명륜캠퍼스 학생
- **핵심 가치 제안**: 단순 위치 기반 지도가 아니라, "지금 내 상황(예산·시간·목적)에 맞는 한 끼"를 구체적인 메뉴 조합으로 추천
- **배포 도메인**: `https://hanipmap.vercel.app` (Vercel, `main` 브랜치 자동 배포)

## 2. 시스템 아키텍처

```
[브라우저]
  ├─ index.html / style.css / app.js (정적 파일, 프레임워크 없는 Vanilla JS)
  ├─ Naver Maps JS SDK (지도 렌더링, 클라이언트 직접 로드)
  └─ Supabase JS client (DB 읽기/쓰기, RLS로 접근 제어)

[Vercel]
  ├─ 정적 파일 호스팅 (index.html, style.css, app.js)
  └─ 서버리스 함수
       ├─ /api/search.js         (네이버 지역 검색 API 프록시, Secret 보관)
       ├─ /api/parse-menu.js     (Upstage Document Parse + Solar, 메뉴판 사진→구조화 — 예정)
       └─ /api/parse-query.js    (Upstage Solar, 자연어 질의 구조화·추천이유 생성 — 예정)

[Supabase]
  ├─ Postgres `restaurants` 테이블 + RLS 정책 (PostgREST로 REST API 자동 노출)
  └─ Postgres `cafeteria_menus` 테이블 (날짜별 학식 식단 — 예정, §4 참고)

[외부 API]
  ├─ Naver Maps (지도 타일/마커)
  ├─ Naver 지역 검색 API (서버리스 경유, 실제 상호명/주소/좌표 조회)
  ├─ Kakao 로컬 API (반경 기반 대량 장소 수집, `scripts/collect-places.js`로 리포에 포함)
  └─ Upstage Document Parse / Solar (메뉴판 OCR, 자연어 이해 — §5.9, §5.10)
```

**설계 원칙**: 백엔드 서버를 별도로 두지 않고, 정적 호스팅(Vercel) + 서버리스 함수 + BaaS(Supabase)만으로 운영한다. Secret이 필요한 API 호출만 서버리스 함수를 거치고, 나머지는 클라이언트에서 직접 호출한다. AI가 자동 생성한 데이터도 반드시 사람이 확인하는 승인 큐(pending → approved)를 거친다.

## 3. 기술 스택

| 영역 | 기술 |
|---|---|
| 프론트엔드 | HTML5, CSS3, Vanilla JavaScript (ES2017+, 빌드 도구 없음) |
| 지도 | Naver Maps JS SDK v3 (`ncpKeyId` 방식) |
| 장소 검색 (실시간) | 네이버 지역 검색 API (`openapi.naver.com/v1/search/local.json`) |
| 장소 대량 수집 (1회성, 리포 포함) | 카카오 로컬 카테고리 검색 API (`dapi.kakao.com/v2/local/search/category.json`), `scripts/collect-places.js` |
| 문서 OCR·구조화 | Upstage Document Parse (`POST /v1/document-digitization`, `model: document-parse`) |
| 자연어 이해·생성 | Upstage Solar (chat completion) |
| 데이터베이스 | Supabase (Postgres + PostgREST + Row Level Security) |
| 배포/호스팅 | Vercel (정적 파일 + 서버리스 함수) |
| 클라이언트 상태 저장 | `localStorage` (최근 검색어, 기본 조건) |

## 4. 데이터 모델

### `public.restaurants`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigint (identity) | PK |
| `name` | text, not null | 상호명 |
| `address` | text | 도로명주소 |
| `lat` / `lng` | double precision, not null | 좌표 (WGS84) |
| `walk_minutes` | integer | 캠퍼스 기준 도보 시간(분). 직선거리 ÷ 80m/분으로 추정 |
| `typical_price` | integer | 대표 가격(원), 목록 카드 표시용 |
| `tags` | text[] | 상황별 태그: `lonely`(혼밥) / `budget10k`(1만원 이하) / `walk5`(도보5분) / `exam247`(시험기간 24시) / `hangover`(해장) / `formal`(격식) / `splurge`(비싼날) |
| `menu` | jsonb | `{name, price}[]` — 예산 맞춤 메뉴 조합 계산에 사용 |
| `hours` | jsonb | `{open, close, breakStart?, breakEnd?, is24h?}` |
| `base_reason` | text | 예산 미지정 시 노출되는 기본 추천 문구 |
| `status` | text, check (`pending`\|`approved`) | 승인 상태 |
| `submitted_by` | text | 제보자 정보(선택) |
| `created_at` | timestamptz | 생성 시각 |

### RLS 정책

- **읽기(SELECT)**: `status = 'approved'` 인 행만 익명 사용자에게 공개
- **쓰기(INSERT)**: 익명 사용자도 새 행을 추가할 수 있으나, `WITH CHECK (status = 'pending')`로 강제되어 항상 대기중 상태로만 생성 가능
- **승인(UPDATE)**: 익명 역할에 UPDATE 정책을 부여하지 않음 → 승인은 프로젝트 소유자가 Supabase Table Editor 또는 SQL Editor에서 직접 수행 (전용 어드민 UI 없음)

### `public.cafeteria_menus` (신규, §5.11 학식 지원용 — 스키마 설계 완료, 미적용)

학식은 "고정 메뉴를 가진 식당"이 아니라 "날짜·끼니별로 매일 바뀌는 식단"이라는 점에서 `restaurants.menu` 구조와 근본적으로 안 맞는다. 그렇다고 완전히 별도 서비스로 분리하면 지도/필터/카드 UI를 통째로 다시 만들어야 한다. 그래서 **하이브리드**로 간다:

- 학식(예: 금잔디식당, 법고을식당)은 `restaurants`에 일반 식당처럼 **1행씩** 등록한다 (좌표·지도·기본 필터 로직을 그대로 재사용하기 위함). 이를 구분하기 위해 `restaurants.category` 컬럼(text, nullable)을 추가하고 값 `'cafeteria'`를 부여한다. 이 컬럼은 필터링 로직에는 관여하지 않고 UI 배지("학식") 표시 용도로만 쓴다.
- 실제로 매일 바뀌는 메뉴·가격은 별도 테이블에 넣는다:

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigint (identity) | PK |
| `cafeteria_name` | text, not null | `restaurants.name`과 매칭되는 학식당 이름 |
| `date` | date, not null | 식단 날짜 |
| `meal_type` | text, check (`breakfast`\|`lunch`\|`dinner`) | 끼니 구분 |
| `items` | jsonb | `{name, price}[]` |
| `price` | integer | 세트 가격이 있는 경우 |
| `source_url` | text | 크롤링 출처 URL (검수·감사용) |
| unique(`cafeteria_name`, `date`, `meal_type`) | | 하루 한 끼당 한 행만 |

- 조회 시(`reasonFor` 등) `restaurants.category === 'cafeteria'`인 행은 자체 `menu`를 쓰지 않고, `cafeteria_menus`에서 오늘 날짜·현재 시간대에 맞는 끼니를 조회해 대체한다.
- **⚠ 데이터 소스 재확인 필요**: 애초 제안됐던 `skku.edu/.../welfare_11.do` 페이지를 직접 확인한 결과, 해당 URL은 학식당 목록과 "메뉴 보기" 링크만 있는 안내 페이지였고 실제 날짜별 메뉴·가격 표는 없었다. 실제 식단 데이터는 각 식당의 "메뉴 보기" 하위 페이지에 있거나 JS로 동적 로딩될 가능성이 있어, **크롤러 구현 전 실제 데이터가 있는 정확한 URL과 구조(정적 HTML인지, API 호출인지)를 먼저 확인해야 한다.**
- 확인 후 정적 HTML 표라면 가벼운 크롤러(스크래핑)로 충분하고, **Upstage Document Parse는 이미 구조화된 HTML에는 쓰지 않는다** — 목적에 안 맞는 제품 적용은 오히려 설계 판단력 부족으로 비칠 수 있다. "사진(비정형) = Document Parse, HTML(정형) = 크롤러"라는 구분을 명확히 유지한다.

## 5. 핵심 기능 명세

### 5.1 자연어 조건 파싱
- `parseBudget(text)`: "8천원 이하" → 8000, "1만원" → 10000 등 정규식 기반 파싱
- `parseWalkMax(text)`: "도보 5분", "300m 이내"(→ 도보 시간으로 환산, 80m/분 가정) 파싱

### 5.2 상황별 태그 필터링
7개 태그 칩 클릭 시 단일 선택(재클릭 시 해제)으로 `activeTag` state를 설정하고, 검색어 텍스트도 함께 채워 필터링에 반영

### 5.3 예산 맞춤 메뉴 추천 (`bestCombo`)
메뉴 항목 부분집합(브루트포스, 항목 수가 적어 O(2ⁿ)으로 충분)을 순회하며 예산 이하에서 총액이 최대인 조합을 계산, 자연어 문장으로 조립 (예: "'순대국밥 특'에 '공기밥' 추가하면 8,000원으로 예산에 딱 맞아요")

### 5.4 영업시간/브레이크타임 판별 (`hoursStatus`)
브라우저의 실제 현재 시각(`new Date()`) 기준으로 영업중/브레이크타임/영업종료/정보없음 상태를 계산. 영업중이 아닌 곳(닫힘/브레이크타임)은 검색 결과에서 자동 제외되나, "정보없음"은 제외하지 않음(데이터가 없을 뿐 실제로 닫혀있다고 단정할 수 없으므로)

### 5.5 지도 마커 인터랙션
- 목록 카드 hover → 해당 마커 확대 강조 (`hover-focus`, 선택 상태와 무관)
- 카드/마커 클릭 → 선택 상태(`active`) 전환 + 지도 `panTo`로 포커싱
- 마커는 Naver Maps의 HTML 콘텐츠 마커 기능으로 구현, 상태 변경 시 `setIcon`으로 재렌더

### 5.6 랜덤 추천 (셔플)
현재 필터링된 목록(`currentList`) 내에서 무작위 선택을 짧게 순환한 뒤 최종 선택으로 착지

### 5.7 개인화 (localStorage)
- 최근 검색어 최대 5개 저장/재사용
- "기본 조건 저장" 후 원클릭으로 재검색

### 5.8 제보(크라우드소싱)
1. 사용자가 상호명 입력 → "주소 찾기" 클릭 → `/api/search`(네이버 지역 검색)로 실제 주소·좌표 자동 조회
2. 메뉴(`메뉴명:가격` 줄바꿈 입력), 태그, 영업시간, 한줄평, 제보자 정보 입력
3. 제출 시 Supabase에 `status='pending'`으로 insert (anon key, RLS로 pending 강제)
4. 운영자가 Table Editor에서 `status`를 `approved`로 변경하면 즉시 서비스에 노출

### 5.9 메뉴판 사진 제보 — Upstage Document Parse (신규, 구현 예정)

기존 제보 폼의 "메뉴명:가격 줄바꿈 타이핑"(§5.8)을 사진 업로드로 대체해, 제보 마찰을 "수 분 타이핑" → "사진 1장"으로 낮춘다.

1. 사용자가 제보 폼에서 메뉴판 사진(JPEG/PNG)을 업로드
2. 클라이언트 → `POST /api/parse-menu` (Vercel 서버리스 함수, 신규)
3. 함수가 Upstage Document Parse API(`POST /v1/document-digitization`, `model: document-parse`) 호출 → 표/텍스트 구조 추출
4. 추출된 원시 텍스트를 Upstage Solar에 다시 보내 `{name, price}[]` 형태로 정제 (OCR이 "아메리카노 ....... 2,500"처럼 뽑아도 Solar가 "아메리카노"/2500으로 정리)
5. **자동 저장하지 않는다** — 제보 폼의 메뉴 입력 textarea에 결과를 미리 채워서 보여주고, 사용자가 틀린 항목을 수정한 뒤 제출 (기존과 동일하게 `status='pending'` insert)
6. 원본 사진은 Supabase Storage에 보관 (승인 시 원본 대조용)

- **비용**: Document Parse는 페이지당 $0.01 과금 확인됨(Upstage 공식 가격 페이지 기준). 가입 시 제공되는 무료 크레딧 규모는 콘솔에서 직접 확인 필요(문서상 정확한 금액을 재확인하지 못함).
- **왜 이 방식인가**: 메뉴·가격 데이터는 어떤 공개 API도 제공하지 않고(§10 첫 항목), 실제 가격은 메뉴판 사진 안에만 존재한다. "OCR/LLM 추출 → 사람 확인 → 운영자 승인"의 3단 구조로 오염을 막으면서 제보 비용을 낮춘다.

### 5.10 자연어 조건 파싱 고도화 — Upstage Solar (신규, 구현 예정, 5.1 확장)

기존 정규식(§5.1)을 1차 파서로 유지하고, Solar를 보조 수단으로 얹는다 (완전 대체 아님).

1. 검색어 입력 → `POST /api/parse-query` (신규 서버리스 함수)
2. Solar chat API에 검색어와 태그 목록(7종)을 함께 보내 `{budget, walkMax, tags: [...], mood: "..."}` 형태로 구조화 — "과선배가 사는 날", "해장 필요" 처럼 정규식이 못 잡는 상황 표현을 태그로 매핑
3. **Solar 실패 또는 2초 타임아웃 시 기존 정규식 결과로 폴백** — 외부 API 장애 상황에서도 검색 기능 자체는 항상 동작하도록 보장
4. 메뉴 조합 추천 문구(`reasonFor`, §5.3)도 Solar로 자연스러운 한 문장 생성 가능 (조합 계산 결과 + 상황 텍스트를 입력으로 전달)

- **도입 순서상 유의점**: 지금처럼 메뉴 데이터가 있는 식당이 전체의 일부뿐인 상태(§10 참고)에서는, 질의 이해를 아무리 잘해도 추천할 데이터 자체가 부족해 체감 효과가 작다. §5.9(데이터 확보)를 먼저 안정화한 뒤 붙이는 것을 권장.

### 5.11 학식 데이터 (신규, 스키마 설계 완료·데이터 소스 재확인 필요)

`§4 cafeteria_menus`에 정의한 대로, 성균관대 학생식당의 날짜별 식단을 별도 테이블로 관리하고 `restaurants.category='cafeteria'` 행과 연결한다. 데이터 소스(크롤링 대상 URL)는 §4에 적은 대로 재확인이 필요한 상태이며, 확인되는 즉시 정적 HTML이면 경량 크롤러로, 동적 로딩이면 별도 API 호출 방식을 조사해 반영한다. **이 항목에는 Document Parse를 사용하지 않는다** (§4 근거 참고).

## 6. 외부 API 연동 상세

| API | 용도 | 키 종류 | 호출 위치 | 비고 |
|---|---|---|---|---|
| Naver Maps JS SDK | 지도 렌더링 | Client ID (공개, 도메인 화이트리스트로 보호) | 클라이언트 직접 | NCP 콘솔에 서비스 도메인 등록 필요 |
| Naver 지역 검색 API | 실시간 상호명/주소/좌표 조회 | Client ID + **Secret** | 서버리스 함수(`api/search.js`)만 | Secret은 Vercel 환경변수로만 보관 |
| Supabase | 식당 데이터 CRUD | anon/publishable key (공개, RLS로 보호) | 클라이언트 직접 | `service_role` 키는 코드/리포에 존재하지 않음 |
| Kakao 로컬 API | 반경 기반 대량 장소 수집 (1회성) | REST API 키 | 로컬 실행 스크립트 `scripts/collect-places.js` (리포 포함, 배포엔 미포함) | 카테고리당 최대 45건 제한 (페이지네이션 한계), 키는 실행 시 환경변수로만 주입 |
| Upstage Document Parse | 메뉴판 사진 → 메뉴·가격 구조화 (§5.9) | **API Key (Secret)** | 서버리스 함수(`api/parse-menu.js`, 구현 예정)만 | 키는 Vercel 환경변수 `UPSTAGE_API_KEY` |
| Upstage Solar | 자연어 조건 구조화·추천 이유 생성 (§5.10) | 동일 키(`UPSTAGE_API_KEY`) | 서버리스 함수(`api/parse-query.js`, 구현 예정)만 | 실패/타임아웃 시 정규식 폴백 |

## 7. 보안 설계

- **Secret 분리**: 브라우저에 노출돼도 되는 키(Naver Maps Client ID, Supabase anon key)와, 반드시 서버 측에만 있어야 하는 키(Naver 검색 Secret, Upstage API Key)를 명확히 구분
- **`.gitignore`**: `.env`, `.env.local`을 커밋 대상에서 제외
- **RLS를 이용한 최소 권한 원칙**: 익명 사용자는 승인된 데이터만 읽고, 신규 제보만 (항상 대기 상태로) 쓸 수 있음. 승인·삭제 권한은 부여하지 않음
- **카카오 REST 키**: 실시간 서비스에 포함되지 않고 1회성 수집 스크립트 실행 시 환경변수로만 주입되며, 배포 환경변수에도 등록하지 않음
- **Upstage API Key**: Naver 검색 Secret과 동일한 원칙으로 서버리스 함수 전용, Vercel 환경변수로만 보관

## 8. 배포 환경 (Vercel)

**필요 환경변수**
| 변수명 | 용도 |
|---|---|
| `NAVER_SEARCH_CLIENT_ID` | 네이버 지역 검색 API 인증 |
| `NAVER_SEARCH_CLIENT_SECRET` | 네이버 지역 검색 API 인증 (서버리스 함수 전용) |
| `UPSTAGE_API_KEY` | Document Parse + Solar 인증 (서버리스 함수 전용, §5.9/§5.10 구현 시 필요) |

환경변수 변경 후에는 반드시 재배포(Redeploy)해야 반영된다.

**외부 콘솔 설정**
- 네이버 클라우드 플랫폼 콘솔: Naver Maps Client ID의 "Web 서비스 URL"에 `https://hanipmap.vercel.app` 등록 필요 (Vercel의 브랜치별 임시 미리보기 URL은 등록 대상에서 제외하고, 고정된 프로덕션 도메인만 등록)

## 9. 운영 접근 권한 (팀 정보 — 채워 넣을 것)

아래는 데이터/운영 정보를 가진 팀원만 채울 수 있는 항목이라 템플릿으로 남긴다.

| 항목 | 담당/접근 범위 | 비고 |
|---|---|---|
| Supabase 프로젝트 오너 | (기입 필요) | 팀원 초대 시 무료 플랜에서도 멤버 추가 가능 |
| 제보 승인(status 변경) 권한자 | (기입 필요) | 현재는 Table Editor 직접 조작, 인원 늘면 관리자 화면 필요(§10) |
| Vercel 프로젝트 환경변수 관리 권한자 | (기입 필요) | **`UPSTAGE_API_KEY` 등록이 곧 필요하므로 실무적으로 가장 시급** |
| 각 외부 콘솔(Naver Cloud Platform, Kakao Developers, Upstage Console) 계정 소유자 | (기입 필요) | 키 재발급/쿼터 확인 시 필요 |

## 10. 알려진 제약사항 및 향후 과제

- **메뉴/가격 데이터의 구조적 한계 (현재 수치)**: 어떤 공개 API도 메뉴·정확한 가격 데이터를 제공하지 않는다(배달앱들이 비공개로 보유). 아래는 2026-07-15 기준 Supabase 실측치다.

  | 지표 | 개수 | 비율 |
  |---|---|---|
  | 전체 등록 식당 | 96 | 100% |
  | 메뉴 정보 보유 | 6 | 6.2% |
  | 대표가격 정보 보유 | 6 | 6.2% |
  | 영업시간 정보 보유 | 6 | 6.2% |
  | 태그 정보 보유 | 6 | 6.2% |
  | 승인(approved) 완료 | 96 | 100% |

  즉 위치 데이터(카카오 API 자동 수집)는 100% 확보됐지만, 서비스의 핵심 가치인 메뉴 기반 추천이 가능한 식당은 전체의 6.2%뿐이다. §5.9(Document Parse 기반 제보) 도입 전/후 이 비율 변화가 곧 이 프로젝트의 핵심 성과 지표가 된다.

- **도보 시간 추정치의 부정확성**: 실제 도보 경로가 아닌 직선거리 기반 추정(÷80m/분)이라 실제와 오차가 있을 수 있음
- **Kakao 로컬 API의 수집 한도**: 카테고리+반경 조합당 최대 45건까지만 조회 가능. 더 넓은 커버리지가 필요하면 반경을 여러 구역으로 나누어(subdivide) 추가 수집 필요 (`scripts/collect-places.js`의 `RADIUS_M`/`CATEGORY_CODES` 조정)
- **승인 프로세스 미자동화**: 현재 승인은 Supabase Table Editor에서 수동으로 처리. 제보량이 늘어나면 별도 관리자 화면이 필요할 수 있음
- **네이버 지역 검색 API의 정확도**: 키워드 매칭 기반이라, 검색어가 모호하면 의도한 것과 다른 업체가 매칭될 수 있음
- **학식 데이터 소스 미확정**: §4/§5.11 참고 — 실제 식단표가 있는 정확한 URL과 구조(정적 HTML/동적 로딩)를 아직 확인하지 못했다
- **Upstage 연동 미구현**: §5.9/§5.10/§6에 설계는 반영했으나 `api/parse-menu.js`, `api/parse-query.js`는 아직 코드로 존재하지 않는다. `UPSTAGE_API_KEY` 발급 및 Vercel 등록이 선행 조건이다 (§9)
