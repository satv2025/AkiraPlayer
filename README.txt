AkiraPlayer (React + Rollup + HLS + Supabase)

Pasos:
1) Copiá tus SVG reales sobre src/assets/media/icons/svg/... (los archivos incluidos están vacíos como placeholder)
2) npm install
3) npm run build
4) npm run serve
5) Abrí http://localhost:3000/public/index.html

Notas:
- El player espera .m3u8 (HLS) y usa hls.js
- Continue Watching guarda en tabla Supabase 'watch_progress'
- Necesitás RLS + políticas + índice único en (user_id, content_id, season_id, episode_id)
