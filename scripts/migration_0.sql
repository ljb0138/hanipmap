-- 한입지도 5-시나리오 구현 계획 0단계: 선행 마이그레이션
-- Supabase SQL Editor에서 그대로 실행하세요.

-- ① 학식/주변 구분
alter table restaurants
  add column category text not null default 'nearby'
  check (category in ('cafeteria', 'nearby'));

-- ⑤ OCR 원본 사진 보존(추후 승인 검토용)
alter table restaurants add column menu_photo_url text;

-- ④ 선택: 서버측 집계용 write-only 로그 (클라이언트 개인화 자체엔 불필요)
create table restaurant_events (
  id bigint generated always as identity primary key,
  session_id text not null,
  restaurant_id bigint references restaurants(id),
  event_type text not null check (event_type in ('view','directions','submit')),
  tags text[],
  created_at timestamptz not null default now()
);
alter table restaurant_events enable row level security;
create policy "anon can insert events" on restaurant_events
  for insert to anon with check (true);
-- select 정책은 의도적으로 없음 (restaurants의 pending insert-only 정책과 동일 원칙)

-- Storage 버킷(menu-photos)은 SQL이 아니라 Supabase 대시보드에서 별도로 만들어야 합니다:
-- Storage → New bucket → 이름 "menu-photos", Public bucket 체크 해제(private)
-- Policies: anon은 INSERT만 (경로 pending/*), SELECT/LIST는 막기 — service-role 키로만 서버에서 읽음
