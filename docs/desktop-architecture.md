# โครงสร้างฝั่ง Desktop

ImageHarvest และ HarvestTS อยู่ในแอป Electron เดียวกัน แต่แยกเจ้าของงานและวงจรเริ่ม/หยุดระบบ

| ส่วน | จุดเริ่มต้น | หน้าที่ |
| --- | --- | --- |
| Collector | `src/collector/index.cjs` | เปิดเว็บเพื่อรวบรวมภาพ สแกน จับภาพ สลับ workspace และบันทึกไฟล์ |
| HarvestTS | `src/harvestts/index.cjs` | จัดการแท็บ บัญชี บุ๊กมาร์ก ดาวน์โหลด งาน OCR/แปล และคลัง Offline |
| Application | `src/main.cjs` | ตั้งค่า Electron ก่อนเริ่ม สร้างหน้าต่างหลัก และเรียก lifecycle ของทั้งสองส่วน |
| Shared | `src/shared/` | ประกอบบริการ ลงทะเบียน protocol และเก็บสคริปต์เลือก element ที่ทั้งสองส่วนใช้ |

## ขอบเขตและสถานะ

- โมดูล backend สร้างด้วย factory และรับบริการที่ต้องใช้เป็น arguments การ import ไฟล์จึงไม่สร้างหน้าต่างหรือเริ่มงานเอง
- Collector เก็บ collection, cache, งานปัจจุบัน และ workspace ใน factory ของตัวเอง ส่วน HarvestTS เก็บแท็บ งานแปล และคิวบันทึก Offline แยกกัน
- `shared/features.cjs` ประกอบบริการโดยรักษา object ที่ใช้เชื่อมต่อให้คงเดิม และเก็บ getter/setter ไว้ด้วย เมื่อ Collector เปลี่ยน workspace บริการอื่นจะอ่านสถานะปัจจุบันได้ ไม่ติดอยู่กับ Map เก่า
- งาน OCR/แปลและกฎบล็อกยังใช้ร่วมกันได้ผ่านบริการที่ส่งเข้ามา ไม่ต้อง import โมดูลของอีกส่วนโดยตรง
- `harvestts/renderer.js` เก็บสถานะแท็บและหน้าจัดการใน closure ส่วน `collector/renderer.js` ดูแลรายการภาพและ workspace ของหน้ารวบรวมภาพ `renderer.js` เป็นส่วนกลางสำหรับ UI และ IPC
- HarvestTS ส่ง URL ให้ Collector ผ่าน callback `sendToCollector` เพื่อให้ Collector เป็นผู้เปิดเว็บและปรับสถานะของตัวเอง

## ข้อควรระวังเมื่อแก้ไข

สคริปต์ที่ส่งเข้าเว็บด้วย `.toString()` ต้องทำงานได้ในบริบทหน้าเว็บ อย่าย้าย helper ที่สคริปต์นั้นใช้ไปไว้ใน closure ของ Node โดยไม่ส่ง helper เข้าไปด้วย

ไฟล์ preload และหน้า HTML เดิมยังอยู่ที่ `src/` เพื่อรักษา URL, session partition และขอบเขต IPC เดิม เส้นทางไฟล์ในโมดูลย่อยต้องอ้างกลับไปที่โฟลเดอร์ `src/` ให้ถูกต้อง

## ตรวจสอบ

```sh
npm run check:desktop
npm test
npm run test:desktop
```

`check:desktop` ตรวจ syntax ของ JavaScript ฝั่ง Desktop และรูปแบบของไฟล์ที่ refactor แล้ว `test:desktop` ตรวจสถานะของโมดูลและการส่ง URL/สแกน/สลับ workspace ในแอปจริง

ใช้ `npm run format:desktop` เพื่อจัดรูปแบบไฟล์ชุดนี้ให้ตรงกัน ชุด E2E เดิม เช่น `test:e2e`, `test:capture` และ `test:overlay` ยังใช้ตรวจพฤติกรรมแต่ละฟีเจอร์ได้
