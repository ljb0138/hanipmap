-- 임베딩 기반 의미검색 도입: pgvector 확장 + embedding 컬럼 + 유사도 검색 함수
-- Supabase SQL Editor에서 실행하세요.

create extension if not exists vector;

alter table restaurants add column embedding vector(4096);

-- 사용자 문장을 임베딩한 벡터를 넣으면, 승인된 식당 중 의미가 가까운 순으로 반환한다.
create or replace function match_restaurants(query_embedding vector(4096), match_count int default 40)
returns table (id bigint, similarity float)
language sql stable
as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from restaurants
  where status = 'approved' and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function match_restaurants(vector, int) to anon;
