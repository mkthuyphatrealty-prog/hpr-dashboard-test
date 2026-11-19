# HPR Dashboard — web app nội bộ tại dashboard.huyphatrealty.vn

Bản độc lập của dashboard HPR Performance (8 tab: Overview, Reports Ads, Reports Content, Report Data, Report Sale, Customer, Conversion, Data Health). Dữ liệu đọc **trực tiếp** từ 5 Google Sheet mỗi khi mở trang (giữ tạm 5 phút), và chỉ người có email `@huyphatrealty.vn` mới vào được.

```
Trình duyệt ──► dashboard.huyphatrealty.vn  (Cloudflare Pages + Cloudflare Access: đăng nhập bằng email công ty)
                    │
                    └─► /api/data  (Pages Function, kiểm tra đăng nhập)
                            │
                            └─► Google Apps Script (có khoá bí mật) ──► 5 Google Sheet
```

## Cấu trúc thư mục

| Đường dẫn | Vai trò |
|---|---|
| `index.html` | **Toàn bộ dashboard trong một file** (HTML + CSS + JavaScript, đã nhúng sẵn thư viện d3). 8 tab: Overview, Reports Ads, Reports Content, Report Data, Report Sale, Customer, Conversion, Data Health |
| `functions/api/data.js` | Cloudflare Pages Function: kiểm tra đăng nhập, gọi Apps Script, giữ tạm dữ liệu |
| `apps-script/Code.gs` | Mã Google Apps Script đọc 5 sheet. **Không** chạy trên Cloudflare, dán vào script.google.com |

**Xem thử khi chưa có /api/data:** mở `index.html` trực tiếp; khi báo không tải được, bấm **Chọn file dữ liệu JSON** và chọn file JSON lấy từ Apps Script (mở URL `…/exec?key=DATA_KEY` trên trình duyệt rồi lưu trang thành `.json`). File này chứa thông tin khách hàng, không gửi ra ngoài.

**Đã có bản cũ?** Bản này cần Apps Script mới (thêm ad_id, adset_id, độ sâu xem video): dán lại `Code.gs` rồi **Deploy → Manage deployments → Edit → New version**.

---

## Bước 1 — Tạo nguồn dữ liệu bằng Google Apps Script (≈10 phút)

1. Đăng nhập **script.google.com** bằng tài khoản Google **xem được cả 5 sheet** → **New project**, đặt tên `HPR Dashboard Data`.
2. Xoá nội dung mặc định, dán toàn bộ `apps-script/Code.gs` → **Save**.
3. **Project Settings** (bánh răng) → **Script Properties** → **Add script property**:
   - Property: `DATA_KEY`
   - Value: một chuỗi ngẫu nhiên dài (≥ 32 ký tự, ví dụ tạo tại 1password.com/password-generator). **Lưu lại**, cần dùng ở Bước 3.
4. Quay lại Editor, chọn hàm `testBuild` → **Run** → cấp quyền khi được hỏi. Mở **Execution log**: phải thấy số dòng `ads`, `sales`, `customers` > 0 và `warnings` rỗng.
5. **Deploy → New deployment** → loại **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (vẫn an toàn: thiếu `DATA_KEY` thì chỉ nhận `unauthorized`)
   - **Deploy** → sao chép **Web app URL** (kết thúc bằng `/exec`).

> Sau này sửa `Code.gs`: **Deploy → Manage deployments → Edit (bút chì) → Version: New version → Deploy** để URL giữ nguyên.

## Bước 2 — Đưa code lên GitHub (≈5 phút)

1. Vào **github.com → New repository** → tên `hpr-dashboard`, chọn **Private** → Create.
2. Bấm **uploading an existing file**, kéo **toàn bộ nội dung** thư mục này vào (giữ nguyên các thư mục `functions`, `apps-script`) → **Commit changes**.

   Hoặc dùng git:
   ```bash
   cd hpr-dashboard
   git init && git add . && git commit -m "HPR dashboard"
   git branch -M main
   git remote add origin https://github.com/<tài-khoản>/hpr-dashboard.git
   git push -u origin main
   ```

## Bước 3 — Triển khai trên Cloudflare Pages (≈10 phút)

> **Điều kiện:** tên miền `huyphatrealty.vn` cần dùng DNS của Cloudflare (gói Free) thì Cloudflare Access mới bảo vệ được tên miền riêng. Nếu chưa: Cloudflare → **Add a site** → `huyphatrealty.vn` → Free → làm theo hướng dẫn đổi **nameserver** tại nhà cung cấp tên miền (Mắt Bão, PA Vietnam, iNET…). Cloudflare tự chép các bản ghi DNS hiện có, website/email đang chạy không bị ảnh hưởng nếu kiểm tra kỹ danh sách bản ghi trước khi đổi.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → chọn repo `hpr-dashboard`.
2. Build settings: Framework preset **None**, Build command **để trống**, Build output directory **`/`** → **Save and Deploy**.
3. Vào project → **Settings → Variables and Secrets** (môi trường Production), thêm:

   | Tên | Giá trị | Loại |
   |---|---|---|
   | `APPS_SCRIPT_URL` | URL `/exec` ở Bước 1.5 | Text |
   | `DATA_KEY` | chuỗi bí mật ở Bước 1.3 | **Secret** |
   | `ACCESS_TEAM` | tên team Zero Trust (Bước 4.1) | Text |
   | `ACCESS_AUD` | AUD tag (Bước 4.4) | Text |
   | `CACHE_SECONDS` | `300` (tuỳ chọn) | Text |

4. **Custom domains → Set up a custom domain** → nhập `dashboard.huyphatrealty.vn` → Cloudflare tự tạo bản ghi CNAME → chờ trạng thái **Active**.

## Bước 4 — Giới hạn chỉ nhân sự công ty truy cập (Cloudflare Access, miễn phí ≤ 50 người)

1. Cloudflare → **Zero Trust** (lần đầu chọn gói Free, đặt team name, ví dụ `huyphat` → team domain `huyphat.cloudflareaccess.com`). Team name này là `ACCESS_TEAM`.
2. **Settings → Authentication → Login methods**: giữ **One-time PIN** (mã gửi qua email), hoặc thêm **Google Workspace** nếu công ty dùng Google Workspace.
3. **Access → Applications → Add an application → Self-hosted**:
   - Application name: `HPR Dashboard`
   - Public hostname: `dashboard.huyphatrealty.vn`; thêm hostname thứ hai là `<tên-project>.pages.dev` để chặn cả đường dẫn mặc định.
   - Policy: **Allow** → Include → **Emails ending in** → `@huyphatrealty.vn` (hoặc liệt kê từng email).
   - Save.
4. Mở lại application → **Overview / Basic information** → sao chép **Application Audience (AUD) Tag** → điền vào biến `ACCESS_AUD` ở Bước 3.3.
5. Pages → **Deployments → … → Retry deployment** để áp dụng biến môi trường.

## Bước 5 — Kiểm tra

1. Mở **https://dashboard.huyphatrealty.vn** → nhập email công ty → nhập mã PIN nhận qua email.
2. Thanh trên cùng hiện "cập nhật …" với giờ vừa tải, các tab có số liệu.
3. Thử mở bằng email ngoài công ty → phải bị chặn.

Lỗi thường gặp (hiện ở thanh trên cùng):

| Thông báo | Cách xử lý |
|---|---|
| `Thiếu biến môi trường …` | Thêm biến ở Bước 3.3 rồi Retry deployment |
| `Chưa đăng nhập Cloudflare Access` / `Token không dành cho ứng dụng này` | Kiểm tra hostname trong Access application và `ACCESS_AUD`, `ACCESS_TEAM` |
| `Apps Script: unauthorized` | `DATA_KEY` ở Cloudflare khác với Script Property |
| `Apps Script không trả về JSON` | Triển khai lại web app với **Who has access: Anyone** |

## Vận hành

- **Số liệu mới:** tự đọc lại sheet sau mỗi 5 phút; nút **↻ Làm mới dữ liệu** đọc ngay.
- **Thêm tab trong sheet:** tab quảng cáo mới (cùng cột `Day, Month, …, Campaign ID`), tab sale mới (có cột `Họ Tên`, `Tình trạng`, `Team nhận … lần 1`), tab CRM mới (có `created_time`) được nhận tự động.
- **Thêm dự án / file sheet sale mới:** thêm một dòng vào `SOURCES.sales` trong `Code.gs` và thêm từ khoá vào tab `PROJEC_MAP`. Núm xoay tự lấy 5 dự án chi tiêu nhiều nhất.
- **Xuất dữ liệu:** nút **Xuất CSV trang này** tải bảng chính của tab đang mở theo bộ lọc hiện tại.
- **Sửa giao diện:** sửa file trên GitHub → Cloudflare tự triển khai lại sau ~1 phút.
- **Bảo mật:** trang có tên, số điện thoại, email khách hàng. Không tắt Access, không chia sẻ `DATA_KEY`, không đổi repo sang Public. Đổi `DATA_KEY` (ở cả hai nơi) nếu nghi bị lộ.
