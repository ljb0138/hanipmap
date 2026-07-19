-- ⑤ 메뉴판 사진 제보: menu-photos 버킷에 대한 Storage RLS 정책
-- 버킷 생성만으로는 anon이 아무 것도 못 합니다(빈 권한). 아래를 Supabase SQL Editor에서 실행하세요.

-- anon은 pending/ 경로에만 업로드(INSERT) 가능, 조회/목록/삭제는 불가
create policy "anon can upload to menu-photos pending"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'menu-photos'
    and (storage.foldername(name))[1] = 'pending'
  );

-- select/list/delete 정책은 의도적으로 없음 — 서버(service-role 키)만 읽을 수 있어야 함
