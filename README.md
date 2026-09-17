# ImageHarvest 1.1.0

แอป Windows สำหรับรวบรวมไฟล์ภาพจากหน้าเว็บ ดูตัวอย่าง กรอง จัดลำดับ และบันทึกไฟล์ต้นฉบับลงเครื่อง รวมโหมดจับเว็บที่เปลี่ยนทีละหน้าโดยให้ผู้ใช้กดเปลี่ยนหน้าเอง

Repository: https://github.com/chinenar/ImageHarvest

## ติดตั้งและเปิดใช้งาน
หลัง build แล้ว ตัวติดตั้งอยู่ที่ `installer-dist\ImageHarvest-Setup-1.1.0.exe`

- Installer เป็นแบบหลายขั้นตอนและ **เลือกโฟลเดอร์ติดตั้งได้**
- สร้าง Desktop shortcut และ Start Menu shortcut
- ติดตั้งแบบ per-user โดยค่าเริ่มต้นอยู่ใต้ `%LOCALAPPDATA%\Programs\ImageHarvest`
- หากรันจากซอร์สโดยตรง ให้ใช้ `Start.cmd` หรือ `npm.cmd start`

## วิธีใช้งาน
ค่าเริ่มต้นคือ **Google Chrome** พร้อม **รองรับระบบป้องกันที่รู้จักอัตโนมัติ**; ต้องติดตั้ง Chrome ในเครื่องก่อน ไม่มีการดาวน์โหลดเบราว์เซอร์เงียบ ๆ หากต้องการใช้ตัวเดิม เลือกเบราว์เซอร์ในแอปได้

1. วาง URL แล้วกด **สแกนภาพ** หรือกด **เปิดเว็บ** เพื่อดู/ล็อกอินก่อน
2. เลือกภาพ กรองขนาดขั้นต่ำ และเรียงตามตำแหน่งบนหน้า / DOM / ชื่อไฟล์ / ลากเอง
3. เว็บที่ต้องกด Next/ลูกศรเองสามารถใช้ **จับทีละหน้า** แล้วเปลี่ยนหน้าในหน้าต่างเว็บ ระบบจะสะสมภาพใหม่ให้
4. เลือกโฟลเดอร์ปลายทาง แล้วกด **บันทึกภาพที่เลือก**

ถ้ากรอกชื่อโฟลเดอร์ชุดภาพ เช่น `1` แอปจะสร้างโฟลเดอร์ชื่อ `1` ตรง ๆ; ถ้ามีอยู่แล้วจะเป็น `1-2`, `1-3` ฯลฯ
ถ้าปล่อยชื่อว่าง จึงค่อยใช้ชื่อหน้าเว็บพร้อมเวลาอัตโนมัติ
ชื่อไฟล์เป็น `0001.png`, `0002.webp` ฯลฯ ตามลำดับของภาพที่เลือกและผ่านตัวกรอง ณ เวลากดบันทึก
แอปไม่แปลงชนิดไฟล์และไม่บีบอัดต้นฉบับซ้ำ และมี `report.json` ระบุผลสำเร็จ/ล้มเหลว

## รองรับใน V1
- IMG และ currentSrc ของ picture/srcset ที่เบราว์เซอร์เลือกใช้
- Lazy loading ผ่านการเลื่อนอัตโนมัติ และ data-src/data-original/data-lazy-src/data-url ที่พบบ่อย
- ภาพพื้นหลัง CSS แบบ url(...), open shadow DOM และพื้นที่อ่านแบบเลื่อนภายในหน้า
- ภาพ data URL และ blob URL ที่ยังเข้าถึงได้จากหน้าเดิม
- JPG, PNG, WebP, AVIF, GIF, BMP, ICO และ SVG
- ซ่อนรูปที่มี URL ซ้ำ และจัดลำดับด้วยการลาก/ลูกศร
- ตั้ง CSS selector ของส่วนเนื้อหา, เวลารอ lazy load และจำนวนรอบเลื่อนสูงสุด
- หยุดสแกนโดยเก็บผลที่พบไว้ และหยุดบันทึกโดยไม่ลบไฟล์ที่เสร็จแล้ว
- ปุ่ม **กลับลำดับ** พลิกลำดับภาพที่สแกนได้ทั้งชุดในคลิกเดียว
- เครื่องมือ **ตั้งเลขหน้ารูป** สำหรับโฟลเดอร์ในเครื่อง: เรียงชื่อตามตัวเลข เลือกปกติ/ย้อนกลับ แล้วเปลี่ยนชื่อเป็น `0001`, `0002`… แบบสองขั้นตอนเพื่อลดปัญหาชื่อชนกัน
- **รวม Canvas**: รอ Canvas ที่ถูกวาดจริงระหว่าง auto-scroll แล้วบันทึกเป็น PNG; Canvas ที่ browser ป้องกันการอ่านพิกเซลจะไม่ถูกข้ามข้อจำกัด

## ข้อจำกัดสำคัญ
- สแกนปกติทำงานกับ **หน้า URL ปัจจุบัน** และไม่คลานทั้งเว็บไซต์หรือกดไปตอนถัดไปเอง; โหมด **จับทีละหน้า** รองรับการสะสมหลายหน้าที่ผู้ใช้กดเปลี่ยนเอง แต่ยังไม่เดาปุ่ม Next ของแต่ละเว็บอัตโนมัติ
- Canvas capture เก็บเฉพาะผลลัพธ์ที่หน้าเว็บวาดและ browser อนุญาตให้อ่านแล้ว ไม่ถอดรหัสไฟล์ต้นทางเอง; ยังไม่สแกนภายใน iframe
- บางเว็บที่เป็น virtualized layout หรือเปลี่ยนตำแหน่งภาพตลอด อาจต้องปรับลำดับเอง
- `srcset` ใช้ภาพที่ Chromium เลือกจริง ไม่เดาว่ารูปใดเป็นต้นฉบับใหญ่ที่สุด
- จำกัด 5,000 occurrences ต่อสแกน, 32 MB ต่อภาพ และแคชไฟล์ภาพในหน่วยความจำไม่เกิน 128 MB
- เลื่อนอัตโนมัติสูงสุด 600 รอบ ไม่ข้าม paywall, CAPTCHA หรือการจำกัดการเข้าถึง
- Cookie/login ใช้เฉพาะเบราว์เซอร์แยกของแอป; Chrome ใช้โปรไฟล์ชั่วคราวบนดิสก์และล้างเมื่อปิดตามปกติ ไม่ยืม cookie ของ Chrome/Edge ส่วนตัว
- เว็บที่ต้องใช้ popup เพื่อเข้าสู่ระบบอาจใช้ไม่ได้ใน V1 เพราะแอปบล็อก popup
- URL ใน report/links อาจมี token ที่เว็บไซต์ใส่มา ไม่ควรเผยแพร่ไฟล์เหล่านี้โดยไม่ตรวจสอบ

## จำนวนคำขอ
คิวโหลดตัวอย่างกับดาวน์โหลดใช้ข้อมูลร่วมกัน โหลดตามคิวเดียวและเว้นอย่างน้อย 400 ms ระหว่างการเริ่มคำขอภาพโดยแอป
เมื่อได้รับ HTTP 429 จะหยุดคำขอภาพใหม่จากโฮสต์นั้นในผลสแกนชุดปัจจุบัน ไม่หมุน IP หรือพยายามหลบข้อจำกัด; ไฟล์ที่เก็บสำเร็จไว้แล้วอ่านและส่งออกแบบออฟไลน์ต่อได้

## พัฒนา ทดสอบ และสร้าง Installer
ต้องมี Node.js 22.12+ และ npm

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:capture
npm.cmd run test:blob
npm.cmd run test:curation
npm.cmd run test:chrome
npm.cmd run package
npm.cmd run dist
```

`npm.cmd run dist` ใช้ electron-builder + NSIS และสร้าง `installer-dist\ImageHarvest-Setup-<version>.exe`

E2E เปิดเว็บทดสอบบน `127.0.0.1` เท่านั้น และบันทึกหลักฐานไว้ใน `test-results`
แอปสร้างด้วย Electron และ JavaScript ไม่มี service หรือ API key ของ AI และไม่ต้องเชื่อม cloud backend

- `src/main.cjs`: browser/session, IPC, scan orchestration, image download, export
- `src/collector.js` / `src/scroll.js`: อ่าน DOM และเลื่อนหน้าใน isolated browser world
- `src/renderer.js` / `src/style.css`: หน้าจอและการจัดลำดับ
- `src/core.cjs`: การตรวจ URL, filename, image bytes, sorting และ bounded cache

## สิทธิ์และความปลอดภัย
ใช้กับภาพที่มีสิทธิ์ดาวน์โหลดหรือได้รับอนุญาตเท่านั้น หน้าต่างเว็บปิด Node integration เปิด sandbox/context isolation และไม่ได้รับ filesystem IPC
แอปไม่ส่งรูปไปยัง server ของแอป แต่เว็บไซต์ที่เปิดยังสามารถส่งคำขอเครือข่ายตามการทำงานปกติของเว็บไซต์
ตัวติดตั้งยังไม่ได้เซ็นด้วย code-signing certificate ของผู้พัฒนา; Windows อาจแสดงคำเตือนแอปที่ไม่รู้จักเมื่อย้าย build ไปเครื่องอื่น

อ้างอิง API: https://www.electronjs.org/docs/latest/tutorial/security ; https://www.electronjs.org/docs/latest/api/session ; https://playwright.dev/docs/api/class-electron

## คัดรูปและจัดการรายการ (1.0.5)
- **นำที่เลือกออก**: นำเฉพาะรายการที่เลือกและกำลังแสดงออกจากผลสแกน มีหน้าต่างยืนยันก่อนทำ
- **คืนรายการล่าสุด**: ย้อนการนำออกครั้งล่าสุด รวมลำดับและสถานะการเลือก ใช้ได้ก่อนสแกนใหม่หรือล้างทั้งหมด
- **ล้างทั้งหมด**: ล้างผลสแกนรวมภาพที่ซ่อน ประวัติคืนรายการ แคช และไฟล์ Canvas ชั่วคราว โดยคง URL/โฟลเดอร์ปลายทาง
- ทั้งสามคำสั่งนี้ไม่ลบหรือแก้ไขไฟล์ที่ดาวน์โหลดไปแล้ว และใช้ไม่ได้ระหว่างสแกนหรือบันทึก
- หลังนำบางรายการออก แคชและไฟล์ Canvas ของรอบสแกนยังอาจคงอยู่ชั่วคราวเพื่อคืนรายการ และถูกล้างเมื่อกดล้างทั้งหมด/สแกนใหม่/ออกจากแอปตามปกติ

ตัวกรองใหม่ปิดไว้โดยค่าเริ่มต้น และเป็นเพียงการซ่อน ไม่ได้ลบผลสแกน:
- **ซ่อนโลโก้ / รูปประกอบเว็บ**: ประเมินจากชื่อไฟล์ alt/class และบริเวณเมนู โฆษณา คอมเมนต์ รูปแนะนำหรือรูปโปรไฟล์
- **เฉพาะเนื้อหาหลัก**: เลือกเขตตัวอ่านที่รู้จักก่อน แล้วจึง main/article หากไม่พบเขตหลักจะเตือนและคงภาพที่ไม่แน่ใจไว้
- **ชนิดภาพ**: เลือกทั้งหมด, IMG, Canvas หรือภาพพื้นหลังได้
- **รีเซ็ตตัวกรอง**: คืนค่าตัวกรอง โดยยังซ่อน URL ซ้ำและไม่คืนรายการที่กดนำออก
- บันทึกเฉพาะรายการที่เลือกและผ่านตัวกรองตามลำดับบนหน้าจอ ณ เวลากดบันทึก

นี่เป็นกฎประเมินจากข้อมูลและโครงสร้างหน้าเว็บ ไม่ใช่ AI อ่านเนื้อหาภาพ จึงอาจคัดผิดได้
หน้าโฆษณาที่แทรกอยู่ในตัวอ่านเหมือนหน้าปกติอาจยังผ่าน ต้องตรวจและเลือกนำออกเอง
การกรองโลโก้คือการซ่อนไฟล์ที่เป็นโลโก้ ไม่ใช่การลบลายน้ำที่ฝังอยู่ในภาพ

## แก้การสแกน Blob และภาพยาว (1.0.7)
- สแกนปกติเก็บไฟล์ Blob ต้นฉบับลงพื้นที่ชั่วคราวทันทีที่พบ ไม่รอจนสแกนจบ จึงยังบันทึกได้เมื่อเว็บเปลี่ยนหรือยกเลิกลิงก์เดิมระหว่างเลื่อน
- เลื่อนข้ามเฉพาะช่วงกลางภาพกว้างและยาวที่โหลดครบ โดยคงพื้นที่เหลื่อม; ภาพ Blob ต้องเก็บสำเร็จก่อนข้าม
- แก้ตัวโหลดภาพ Chrome ที่เลือก DNS ใหม่แล้วเรียกฟังก์ชันผิดโมดูล และเพิ่มทดสอบ resolver ทั้ง IP literal/hostname/error
- ทดสอบ Readtoon ตอนที่ 9 จากลิงก์ที่ผู้ใช้ให้: 1.0.6 เดิมพบ 17 ภาพ บันทึก 15; ซอร์สที่แก้พบ 23 ภาพ บันทึกและถอดรหัสได้ 23/23 เรียงภาพที่ 1–23
- ไม่ได้เปลี่ยนระบบสิทธิ์เว็บไซต์ หรือแก้การรองรับเว็บอื่นจากผลทดสอบตอนนี้

## จับทีละหน้า (1.0.6)
- กด **จับทีละหน้า** แล้วเปิดหน้าต่างเว็บค้างไว้ จากนั้นกด Next / ลูกศร / ปุ่มเปลี่ยนหน้าของเว็บไซต์เอง
- ตั้งแต่ 1.0.9 แอปตื่นจับทันทีเมื่อ hash/history, IMG src/srcset, การซ่อน/แสดง element หรือ image load เปลี่ยน และยังมี polling สำรองสำหรับ Canvas ที่วาดทับโดย DOM ไม่เปลี่ยน
- หลังจับไฟล์สำเร็จจะคำนวณ SHA-256 จากข้อมูลภาพจริง; เนื้อหาเดิมจึงไม่ถูกเพิ่มซ้ำแม้เว็บไซต์จะใช้ Canvas หรือ URL เดิม
- รอบที่อ่านภาพหรือ Canvas ไม่สำเร็จจะ **ไม่** ถูกทำเครื่องหมายว่าเคยเก็บแล้ว และลองใหม่ในรอบถัดไปได้
- Snapshot ที่สำเร็จถูกเก็บเป็นไฟล์ชั่วคราวทันที เพื่อให้หน้าก่อนหน้ายังคงเดิมแม้ Canvas ต้นทางถูกวาดทับ
- หยุด Capture Session ก่อนจัดลำดับ ลบรายการ หรือบันทึกไฟล์ เพื่อไม่ให้รายการเปลี่ยนระหว่างทำงาน

## DNS / Network compatibility (1.0.6)
เลือกโหมดเครือข่ายได้จากหน้าแอป: **อัตโนมัติ**, **Cloudflare DNS**, **Google DNS**, **AdGuard DNS** และ **Compatibility**

- Cloudflare/Google ใช้ DNS-over-HTTPS ใน Electron และใช้ resolver ที่เลือกกับการดาวน์โหลดภาพของ Chrome mode ด้วย
- Compatibility ใช้ Cloudflare DNS และปิด HTTP/2 + QUIC; ต้องรีสตาร์ตแอปเพราะ Chromium ต้องรับ flags ก่อนเริ่มทำงาน
- เมื่อพบ `ERR_HTTP2_PROTOCOL_ERROR` แอปจะแนะนำ Compatibility; timeout/name-resolution จะแนะนำ Cloudflare/Google
- ตัวเลือกเหล่านี้ช่วยแก้ความเข้ากันได้ของเครือข่าย ไม่ได้ข้าม HTTP 403, CAPTCHA, paywall หรือข้อจำกัดสิทธิ์ของเว็บไซต์

### Smart Auto (1.0.8)
- โหมด **อัตโนมัติ** ใช้ Secure DNS ของ Cloudflare เป็นทางหลักและ Google เป็นสำรอง เพื่อลดปัญหา DNS ของเครือข่ายชี้ไปปลายทางที่ timeout
- ระบบสลับสำรองเฉพาะ timeout / name-resolution / network-unreachable; ไม่ retry เพื่อข้าม HTTP 403, CAPTCHA หรือ access challenge
- จำ DNS ที่ใช้ได้ต่อโดเมนใน session ปัจจุบัน เพื่อลดการลองซ้ำ และยังเลือก Cloudflare / Google / Compatibility เองได้
- ทดสอบตัวแพ็กกับ URL ที่ผู้ใช้รายงาน: Hitomi เปิดได้ทั้งหน้าเรื่องและ reader; nhentai gallery เปิดได้ ส่วนหน้าที่เว็บตอบ `Just a moment...` ยังคงรายงานเป็น access gate

### AdGuard DNS + reader แบบทีละหน้า (1.0.9)
- เพิ่ม **AdGuard DNS** เป็นตัวเลือกแยกแบบ opt-in ใช้ AdGuard Public DNS โหมด Default สำหรับบล็อกโฆษณาและตัวติดตาม ไม่ใช่ Family mode
- หากเว็บพึ่งพาโดเมนที่ถูก AdGuard กรองจนโหลดไม่ครบ ให้กลับ **Smart Auto**; แอปไม่บังคับเปิด AdGuard ให้เอง
- โหมด **จับทีละหน้า** เป็น event-driven สำหรับ reader ที่เปลี่ยนหน้าด้วย URL hash/history หรือสลับ IMG source และยังมี polling สำรองสำหรับ Canvas
- สแกนปกติยังเก็บเฉพาะหน้าปัจจุบัน; เว็บที่แสดงทีละหน้าให้กด **จับทีละหน้า** แล้วใช้ปุ่ม Next/ลูกศรของเว็บ
- Live test Hitomi `reader/19324.html#2`: ตั้ง polling fallback 3,000 ms แต่ตัวแพ็ก 1.0.9 จับหน้าหลังคลิก Next ได้ประมาณ 210 ms จึงยืนยันว่าตื่นจาก page/image change จริง

## ประวัติ Google Chrome mode 1.0.5
Choose **Google Chrome จริง (ทดลอง)** above the URL, then open or scan the page.
This mode runs the installed Google Chrome in a visible window through Playwright/CDP.
The DevTools panel is not opened. Browser security settings remain enabled.
Site scripts are left unchanged unless the opt-in site-compatibility option below is enabled.

- Chrome must already be installed. There is no silent browser download or fallback to another brand.
- A fresh, temporary ImageHarvest profile is created. Personal Chrome profiles and their cookies are never imported.
- Log in manually inside the app-created Chrome window when authorized. Closing ImageHarvest closes this Chrome instance and removes its temporary profile.
- Image downloads use only cookies from this app-created session, keep the size limit, and stop at HTTP 403/429 rather than bypassing access checks.
- Extra popup tabs are closed in this initial implementation; popup-based login may not work.
- Canvas collection keeps the browser's origin-clean checks. Tainted Canvas is not exported.
- A website may still reject automation or navigate away even when no DevTools panel is visible. Chrome mode does not guarantee access to every website.
- The default embedded browser remains available. This release does not include a Chrome extension.

`playwright-core` is now a production dependency for Chrome mode, in addition to its test usage.
Run `npm.cmd run test:chrome` on a Windows machine with Google Chrome installed.
The local fixture verifies lazy Canvas capture while a dimension-based inspect detector continues running.
It is a synthetic test, not a clone of any third-party site's complete protection system.
API references: https://playwright.dev/docs/api/class-browsertype ; https://playwright.dev/docs/api/class-cdpsession

## ประวัติ 1.0.10 — โหมดเฉพาะเว็บ (ถูกแทนที่ใน 1.1.0)

ติ๊ก **โหมดเฉพาะ NTRNaja / Pengi** ก่อนเปิด URL; แอปจะเลือก Google Chrome จริงให้โดยอัตโนมัติ
โหมดนี้ปิดเป็นค่าเริ่มต้น บันทึกตัวเลือกไว้ในเครื่อง และมีผลเฉพาะโดเมนที่ระบุตรงตัวเท่านั้น

- NTRNaja: ยกเลิกเฉพาะคำขอสคริปต์ตรวจจับสองรายการที่ตรวจไว้ ไม่บล็อก CDN ทั้งโดเมน
- Pengi: ตรวจ SHA-256 ของ reader bundle ก่อนปรับเฉพาะจุดเริ่ม detector และ callback ที่ทำให้แท็บค้าง
  ส่วน reader, การตรวจสิทธิ์, API, ลายน้ำ และ MutationObserver เดิมไม่ถูกแก้
- หาก Pengi เปลี่ยน bundle ที่ตรวจพบ จะหยุดและแจ้งให้อัปเดตกฎ ไม่พยายามแทนโค้ดแบบเดาสุ่ม
- ตัวเลื่อนใช้ `scrollTo/scrollBy` แบบ instant โดยไม่เขียน inline style ของหน้าเว็บ
- เก็บต้นฉบับจาก image response ที่ Chrome ได้รับสำเร็จแล้ว และผูกกลับกับลำดับภาพใน DOM
- ในโหมดเฉพาะเว็บ ภาพ HTTP ที่ Chrome ยังไม่ได้โหลดสำเร็จจะรายงานว่าขาดข้อมูล ไม่ยิง HTTP client ซ้ำ
- แคช response จำกัด 32 MiB ต่อภาพ และ 512 MiB ต่อเซสชัน; ใช้โปรไฟล์ชั่วคราวของแอปและล้างเมื่อปิด
- ชุดภาพที่สแกนสำเร็จมี snapshot แยกสำหรับ Preview/Export และ `report.json` มี SHA-256 กับวิธีรับภาพ
- ไม่มีการแก้ response 401/403/429 เป็นสำเร็จ ไม่แก้ CAPTCHA, การล็อกอิน, หรือสิทธิ์ซื้อตอน
- หน้าเว็บยังอาจเปลี่ยนโครงสร้างหรือเงื่อนไขการเข้าถึงได้; ไม่รับประกันทุกตอนหรือทุกเว็บไซต์

ทดสอบกฎและการเก็บ response ด้วย `npm test` และ `npm run test:sites`
การทดสอบเว็บจริงแยกอยู่ใน `test-results/` ซึ่งไม่ส่งขึ้น Git และไม่เป็นส่วนหนึ่งของ regression อัตโนมัติ


## 1.1.0 — Generic Protection Compatibility

- ไม่ตรวจ hostname หรือชื่อไฟล์เพื่อเลือกกฎอีกต่อไป ตรวจเนื้อหาสคริปต์ HTTP(S) ที่ Chrome ได้รับ ก่อนรัน
- รู้จัก 3 ลายเซ็น SHA-256 ที่ตรวจแล้ว: disable-devtool 0.3.9 UMD, devtools-detect fork 2.1 ESM และ integrated reader build ที่ตรวจเมื่อ 18 ก.ย. 2026
- รองรับการย้ายไฟล์เดิมไปโดเมน/เส้นทางใหม่โดยไม่เพิ่มรายชื่อเว็บ แต่ไม่ใช่รองรับทุกเวอร์ชันในตระกูลนั้น
- ถ้าเนื้อหาเปลี่ยนแม้ชื่อ library เหมือนเดิม: ไม่ patch อัตโนมัติ รายงาน unknown แล้วปล่อยโค้ดเดิมตามปกติ
- ข้อยกเว้นด้านความปลอดภัย: ถ้าพบร่องรอยชุดจัดสรรหน่วยความจำอันตรายที่ยังไม่ตรงกฎ จะระงับสคริปต์และหยุดสแกนให้ตรวจใหม่ ไม่เดาแก้ และไม่ใช่เครื่องมือตรวจ malware ครบทุกชนิด
- กฎ standalone คง API/default export ที่ตัวเรียกต้องใช้ แทนการบล็อกไฟล์จน dependency หาย
- รายละเอียดการตรวจมี family, rule ID และ hash; URL diagnostic ตัด query/fragment/credentials ออก ไม่บันทึก cookie หรือ body สคริปต์
- ปุ่มเปิดอัตโนมัติยังปิดได้ และจำค่าที่ผู้ใช้เลือก; ตัวเลือกเฉพาะสองเว็บเดิมเลิกใช้แล้ว
- Chrome เก็บ successful image response ทุกเว็บ ไม่ขึ้นกับว่าพบ protection หรือเปิด engine ไว้หรือไม่ รองรับ URL redirect alias และ snapshot ยังอยู่หลังปิด Chrome
- ใช้ไฟล์ snapshot ที่ hash เหมือนกันร่วมกัน ลดการเก็บภาพซ้ำ; แคช response จำกัด 32 MiB/ภาพ และ 512 MiB/เซสชัน
- การวิเคราะห์สคริปต์มีเพดาน 2 MiB/ไฟล์, 300 ไฟล์ และประมาณ 32 MiB/เอกสาร; ไม่ใช่การตรวจทุกไบต์ของทุกเว็บ
- เมื่อเปิดการรองรับอัตโนมัติ จะไม่ให้ Service Worker เริ่มในโปรไฟล์ชั่วคราวของแอป เพื่อไม่ให้ข้ามการตรวจคำขอ; เว็บไซต์ที่พึ่ง PWA/Service Worker อาจต้องปิดตัวเลือกนี้และเปิดหน้าใหม่
- ไม่แก้ inline script, worker/OOPIF ทุกบริบท หรือไฟล์ที่เกินขอบเขตการตรวจ ไม่ปิด CSP/CORS/SRI ไม่รับประกันเว็บที่ใช้ integrity หรือ reader พึ่ง detector แตกต่างจากที่ทดสอบ
- ไม่แก้ CAPTCHA, login, entitlement หรือเปลี่ยน HTTP error เป็น success; unknown server challenges คงเดิม

Tests: `npm test`, `npm run test:protection`, `npm run test:sites` และ regression suites เดิม
ชุด test:protection ต้องมีสำเนา OSS สองไฟล์จากผลตรวจที่ hash ตรงใน test-results; ไม่ส่ง reader bundle ของเว็บอื่นขึ้น Git
Unit tests ที่ต้องใช้สำเนาผลตรวจจะระบุ skip เมื่อไม่มีไฟล์ จึงไม่ควรตีความว่า skip คือผ่านการตรวจตัวไฟล์จริง
