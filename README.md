# ImageHarvest 1.0.1

แอป Windows สำหรับรวบรวมไฟล์ภาพจากหน้าเว็บหนึ่งหน้า ดูตัวอย่าง กรอง จัดลำดับ และบันทึกไฟล์ต้นฉบับลงเครื่อง

Repository: https://github.com/chinenar/ImageHarvest

## ติดตั้งและเปิดใช้งาน
หลัง build แล้ว ตัวติดตั้งอยู่ที่ `installer-dist\ImageHarvest-Setup-1.0.1.exe`

- Installer เป็นแบบหลายขั้นตอนและ **เลือกโฟลเดอร์ติดตั้งได้**
- สร้าง Desktop shortcut และ Start Menu shortcut
- ติดตั้งแบบ per-user โดยค่าเริ่มต้นอยู่ใต้ `%LOCALAPPDATA%\Programs\ImageHarvest`
- หากรันจากซอร์สโดยตรง ให้ใช้ `Start.cmd` หรือ `npm.cmd start`

## วิธีใช้งาน
1. วาง URL แล้วกด **สแกนภาพ** หรือกด **เปิดเว็บ** เพื่อดู/ล็อกอินก่อน
2. เลือกภาพ กรองขนาดขั้นต่ำ และเรียงตามตำแหน่งบนหน้า / DOM / ชื่อไฟล์ / ลากเอง
3. เลือกโฟลเดอร์ปลายทาง แล้วกด **บันทึกภาพที่เลือก**

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

## ข้อจำกัดสำคัญ
- สแกน **หน้า URL ปัจจุบัน** ไม่ได้คลานทั้งเว็บไซต์หรือกดไปตอนถัดไปเอง
- V1 ไม่ดึงภาพที่วาดอยู่ใน canvas, ไม่สแกนภายใน iframe และไม่ถอดภาพที่เว็บแบ่งชิ้น/เข้ารหัส
- บางเว็บที่เป็น virtualized layout หรือเปลี่ยนตำแหน่งภาพตลอด อาจต้องปรับลำดับเอง
- `srcset` ใช้ภาพที่ Chromium เลือกจริง ไม่เดาว่ารูปใดเป็นต้นฉบับใหญ่ที่สุด
- จำกัด 5,000 occurrences ต่อสแกน, 32 MB ต่อภาพ และแคชไฟล์ภาพในหน่วยความจำไม่เกิน 128 MB
- เลื่อนอัตโนมัติสูงสุด 600 รอบ ไม่ข้าม paywall, CAPTCHA หรือการจำกัดการเข้าถึง
- Cookie/login ใช้เฉพาะเบราว์เซอร์แยกของแอป อยู่ในหน่วยความจำและไม่ยืม cookie ของ Chrome/Edge
- เว็บที่ต้องใช้ popup เพื่อเข้าสู่ระบบอาจใช้ไม่ได้ใน V1 เพราะแอปบล็อก popup
- URL ใน report/links อาจมี token ที่เว็บไซต์ใส่มา ไม่ควรเผยแพร่ไฟล์เหล่านี้โดยไม่ตรวจสอบ

## จำนวนคำขอ
คิวโหลดตัวอย่างกับดาวน์โหลดใช้ข้อมูลร่วมกัน โหลดตามคิวเดียวและเว้นอย่างน้อย 400 ms ระหว่างการเริ่มคำขอภาพโดยแอป
เมื่อได้รับ HTTP 429 จะหยุดคำขอภาพจากโฮสต์นั้นในผลสแกนชุดปัจจุบัน ไม่หมุน IP หรือพยายามหลบข้อจำกัด

## พัฒนา ทดสอบ และสร้าง Installer
ต้องมี Node.js 22.12+ และ npm

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
npm.cmd run test:e2e
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
