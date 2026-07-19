-- 같은 식당에 대한 중복 제보를 막고, "가장 메뉴가 풍부한 제보"가 대표 메뉴로 채택되도록
-- 하기 위한 컬럼. 제보 폼에서 이미 등록된 식당 이름과 매칭되면 새 식당을 만드는 대신
-- 이 컬럼에 대상 식당 id를 채워서 "메뉴 업데이트 제안"으로 저장한다.
-- Supabase SQL Editor에서 실행하세요.

alter table restaurants add column target_restaurant_id bigint references restaurants(id);
