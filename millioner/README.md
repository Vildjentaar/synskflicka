# python "c:\VBT_Topluluk_Günleri\VBT Milyoner\backend\main.py"

# Yarışmacı Bilgisayarı: http://localhost:8001/
# Büyük Stand Monitörü / TV: http://localhost:8001/leaderboard (Klavyeden F tuşuna basarak tam ekrana alın)
# Yönetim Paneli: http://localhost:8001/admin (Şifre: akdeniz2026)
# Detaylı kullanım kılavuzu için 

# README.md
# dosyasını inceleyebilirsiniz. Sunucu şu an arka planda http://localhost:8001/ adresinde canlı olarak çalışmaktadır.

# 🧠 Kim Veri Bilimci Olmak İster? — Akdeniz VBT Stand Yarışması

**Topluluk:** Akdeniz Veri Bilimi Topluluğu (VBT)  
**Etkinlik:** Topluluk Günü Standı — Canlı Katılımcı Bilgi Yarışması  
**Tema & Tasarım:** VBT Car projesi ile aynı siberpunk/neon cyan-mor cam efektleri, ses sentezi ve canlı liderlik altyapısı.

---

## 📌 Oyun Konsepti

Standımıza gelen öğrenciler, **12 soruluk** bir "Kim Milyoner Olmak İster" formatında yarışır. Para yerine **Parametre** kazanırlar (1K Parametreden başlayıp büyük dil modelleri esprisiyle **1 Milyar Parametre 👑** finaline kadar gider).

- **12 Seviye:**
  - 1-3: Isınma (30 sn)
  - **4. Soru:** 🛡️ **1. BARAJ (10K Param)** — Yanlış cevaplansa dahi bu ödül garanti!
  - 5-7: Orta seviye (45 sn)
  - **8. Soru:** 🛡️ **2. BARAJ (250K Param)** — İkinci garanti basamağı!
  - 9-11: Zor seviye (60 sn)
  - **12. Soru:** 👑 **1 MİLYAR PARAMETRE (90 sn)** — Bilen yarışmacı **Milyarderler Duvarı**'na adını yazdırır ve stand büyük ödülünü alır!

- **4 Aşamalı Joker (Herkesin Bildiği Pratik İsimlerle):**
  - ✂️ **%50 Yarı Yarıya** (1. sorudan itibaren): İki yanlış şıkkı siler, geriye 1 doğru 1 yanlış şık bırakır.
  - 👥 **Seyirciye Sor** (1. sorudan itibaren): Salondaki seyircilerin oy dağılım grafiğini gösterir.
  - 🤖 **Yapay Zekaya Sor** (5. sorudan itibaren açılır): Yapay zeka asistanı en olası cevabı ve güven skorunu (%) üretir.
  - 🔁 **Çift Cevap Hakkı** (9. sorudan itibaren açılır): O soru için 2 cevap hakkı verir (ilk yanlışta elenmez).

- **Hile Koruması:** Doğru cevaplar asla tarayıcıya (frontend) gönderilmez. Cevap doğrulaması ve süre kontrolleri backend'de oturum bazlı yapılır.
- **Üye Kazanımı:** Başlangıçta alınan isim ve e-posta veritabanında saklanır; oyun bitişinde topluluk katılım linki için **QR Kod** ekranda belirir.

---

## 🚀 Stand Günü Kurulumu ve Başlatma

### 1. Sunucuyu Başlatın
Terminali açıp şu komutu verin:
```bash
python "c:\VBT_Topluluk_Günleri\VBT Milyoner\backend\main.py"
```
Sunucu yerel ağa açık olarak **`http://0.0.0.0:8001`** portunda çalışacaktır.  
*(VBT Car port 8000'de, VBT Milyoner port 8001'de çakışmadan aynı anda çalışabilir).*

### 2. Stand Cihazlarını Bağlayın
- **Yarışmacı Bilgisayarı / Tableti:**  
  Tarayıcıda açın: `http://localhost:8001/`
- **Büyük Stand Monitörü / TV (Canlı Skor Tahtası):**  
  Tarayıcıda açın: `http://localhost:8001/leaderboard`  
  Klavyeden `F` tuşuna veya ekrandaki **⛶ Tam Ekran** butonuna basarak TV moduna alın. Tablo her 3.5 saniyede bir otomatik yenilenir.
- **Stand Görevlisi / Yönetim Paneli:**  
  Tarayıcıda açın: `http://localhost:8001/admin`  
  Yetki Anahtarı: `akdeniz2026`

---

## 🎮 Klavye Kontrolleri (Sunucu veya Yarışmacı İçin)

| Tuş | Eylem |
|---|---|
| **A / B / C / D** | İlgili şıkkı seçer ve onay modalını açar |
| **Enter** | "Son kararın mı?" onaylar veya sonraki soruya geçer |
| **Esc** | Onay modalından vazgeçer (başka şık seçmeye döner) |
| **M** | Sesi Aç / Kapat |
| **F** | Tam Ekran Modu |

---

## 🛠️ Yönetim Paneli Özellikleri (`/admin`)

1. **Katılımcıları İndirme (CSV/Excel):**  
   Stand bitiminde yarışmaya katılan öğrencilerin isimlerini, e-postalarını, üyelik taleplerini ve ulaştıkları basamakları tek tıkla Excel uyumlu CSV olarak indirin.
2. **Topluluğa Katıl QR Linki:**  
   Oyun sonu ekranında çıkacak QR kodunun yönlendireceği WhatsApp grubu veya Google Form linkini dinamik olarak değiştirebilirsiniz.
3. **Soru Bankası Yönetimi:**  
   İstediğiniz an yeni soru ekleyebilir veya mevcut soruları silebilirsiniz (Havuzda şu an 60 hazır soru bulunmaktadır).
4. **Skorları Sıfırlama:**  
   Stand açılmadan önce yapılan test kayıtlarını temizlemek için kullanılır.

---

## 📂 Dizin Yapısı

```
VBT Milyoner/
├── questions.json              # 12 seviye için zengin soru bankası
├── settings.json               # Dinamik ayarlar (QR katılım linki)
├── backend/
│   ├── main.py                 # FastAPI API uç noktaları & statik sunucu (Port 8001)
│   ├── models.py               # SQLite veritabanı şeması & Pydantic modelleri
│   ├── game_logic.py           # Oturum yönetimi, jokerler ve süre kuralları
│   └── milyoner.db             # Kalıcı katılımcı ve skor veritabanı
├── frontend/
│   ├── index.html              # Yarışmacı kayıt & giriş ekranı
│   ├── game.html               # 12 soruluk yarışma arayüzü & modallar
│   ├── leaderboard.html        # Büyük ekran liderlik tablosu & Milyarderler Duvarı
│   ├── admin.html              # Soru & katılımcı yönetim paneli
│   ├── css/
│   │   └── style.css           # VBT Car ile uyumlu neon siberpunk cam teması
│   ├── js/
│   │   ├── api.js              # Ortak API istemcisi & joker meta verileri
│   │   ├── sound-synth.js      # Web Audio API ile sıfır harici dosyasız ses sentezi
│   │   └── game.js             # Oyun döngüsü, durum makinesi & klavye kontrolleri
│   └── assets/
│       └── vbt_logo.png        # Akdeniz VBT logosu
└── README.md
```

---
**Akdeniz Veri Bilimi Topluluğu © 2026**
