# Nguyễn Sơn — Edit Suite

Portfolio dạng phần mềm dựng phim: một thế giới cuộn ngang dùng Three.js, chia thành 6 cảnh (Intro, Video, Design, AI, Career, Contact) và có timeline điều hướng ở đáy màn hình.

## Chạy local

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # xuất ra dist/
npm run preview  # chạy bản build ở http://localhost:4173
```

## Sửa nội dung

Toàn bộ nội dung nằm trong `src/data/`, không cần đụng vào code 3D.

| File | Nội dung |
|---|---|
| `videos.json` | 49 video Cloudinary: `id` là public id, `cat` là một khóa trong `categories.json` |
| `categories.json` | Nhãn và màu của từng loại video (bộ lọc, viền sáng, timeline) |
| `designs.json` | Bản in trên bàn soi: `img`, `url` Behance; `fx`/`fy` là vị trí theo tỉ lệ bàn (-0.5…0.5), `rot` là góc nghiêng (radian) |
| `notes.json` | Giấy note trên bàn soi; note có `url` thì bấm vào sẽ mở link |
| `ai-graph.json` | `nodes`: các node pipeline AI (`fx`/`fy` như trên; `action` có thể là `ai-video` hoặc `contact`). `edges`: cặp `[từ, tới]` theo `key` |
| `career.json` | `items`: các chặng, `from`/`to` là `[năm, tháng]`, `to: null` = đang chạy; `track` là `work`, `side` hoặc `edu`; `when` là nhãn hiển thị. `now: null` = lấy tháng hiện tại |

Các thiết lập khác (email, 5 video showreel ở intro, link Cloudinary) nằm trong `src/config.js`.

**Ảnh và thẻ hồ sơ:**
- Ảnh chân dung (avatar trên HUD và thẻ hồ sơ): `public/profile.jpg`. Thay file cùng tên là xong.
- Ảnh bìa bản in trên bàn soi: để trong `public/designs/`, rồi trỏ trường `img` trong `designs.json` tới `designs/<tên-file>`. Dùng file trong `public/` thay vì link Behance trực tiếp, vì Behance không cho trang khác dùng ảnh của họ.
- Nội dung thẻ hồ sơ (khái quát, kỹ năng, công cụ) và các chương là HTML trong `index.html`.

## Cấu trúc code

- `index.html`: phần chữ của các chương (DOM), cùng bản rút gọn cho máy không chạy được JS hoặc WebGL.
- `src/main.js`: điểm vào; chỉ tải phần 3D khi trình duyệt hỗ trợ WebGL.
- `src/app.js`: toàn bộ phần 3D, gồm scene, thẻ, bàn soi, node graph, sequence career, clapperboard, timeline và viewer.
- `src/styles.css`: giao diện.

## Deploy lên GitHub Pages

1. Đẩy code lên nhánh `main` của repo.
2. Trên GitHub, vào **Settings → Pages → Build and deployment → Source** và chọn **GitHub Actions**.
3. Mỗi lần push lên `main`, workflow `.github/workflows/deploy.yml` sẽ tự build và deploy.

`vite.config.js` dùng `base: './'`, nên trang chạy được ở cả `username.github.io/<repo>/` lẫn domain riêng mà không cần sửa gì.
