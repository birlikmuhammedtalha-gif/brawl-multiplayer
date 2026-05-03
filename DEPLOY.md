# 🚀 Brawl Arena Multiplayer — Deploy Talimatları

## Klasör Yapısı
```
brawl-multiplayer/
├── server.js
├── package.json
└── public/
    └── index.html
```

---

## 1. GitHub'a Yükle

1. GitHub'da yeni repo oluştur: https://github.com/new
   - İsim: `brawl-multiplayer`
   - Public seç → Create repository

2. Bilgisayarında terminal aç, klasörün içine gir:
```bash
cd brawl-multiplayer
git init
git add .
git commit -m "ilk commit"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/brawl-multiplayer.git
git push -u origin main
```

---

## 2. Railway'e Deploy Et (Ücretsiz)

1. https://railway.app adresine git
2. GitHub ile giriş yap
3. **"New Project"** → **"Deploy from GitHub repo"**
4. `brawl-multiplayer` reposunu seç
5. Railway otomatik olarak `npm start` çalıştırır

Deploy tamamlandığında sana şöyle bir URL verir:
```
https://brawl-multiplayer-production.up.railway.app
```

---

## 3. Oyna!

1. Bu URL'yi arkadaşına gönder
2. İkiniz de aynı **oda kodunu** yazın (örn: `oda123`)
3. Mod seçin (Arena veya Futbol)
4. **"Odaya Katıl"** butonuna basın
5. İlk katılan **"Oyunu Başlat"** butonunu görür
6. Başlat!

---

## Kontroller

| Tuş | Aksiyon |
|-----|---------|
| WASD veya Ok Tuşları | Hareket |
| C veya Ç | Ateş / Top vur |

---

## Notlar
- Railway ücretsiz tier: 500 saat/ay (yeterli)
- Maksimum 6 oyuncu aynı odada
- Oda kodu istediğin herhangi bir şey olabilir
- Farklı arkadaşlarla oynamak için farklı oda kodları kullan
