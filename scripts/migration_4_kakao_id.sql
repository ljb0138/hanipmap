-- 카카오 place id를 저장해 향후 재수집 시 이름 대조가 아니라 정확한 id로 중복을 걸러낸다.
-- Supabase SQL Editor에서 실행하세요.

alter table restaurants add column kakao_id text;
