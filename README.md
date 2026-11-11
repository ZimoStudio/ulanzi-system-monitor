# System Monitor untuk Ulanzi Deck (D200)

Plugin yang paparkan status komputer anda terus pada key. Dibina guna [UlanziDeckPlugin-SDK](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK) (Node.js main service + HTML Property Inspector).

## Action yang ada (14)

| Action | Paparan |
|---|---|
| **Open Dashboard** | Tekan untuk buka dashboard web penuh dalam browser (key papar graf CPU hidup) |
| CPU Usage | Peratus penggunaan CPU + bilangan thread |
| Memory Usage | Peratus RAM + digunakan / jumlah |
| Disk Usage | Peratus drive pilihan + digunakan / jumlah |
| Network Speed | Kelajuan download & upload + graf mini |
| GPU Usage | Peratus GPU + VRAM (NVIDIA paling lengkap) |
| Temperature | Suhu CPU atau GPU |
| System Overview | CPU / RAM / Disk dalam 3 bar pada satu key |
| **Ping** | Latency (ms) ke host pilihan, contoh `1.1.1.1` atau `google.com` |
| **Uptime** | Berapa lama PC hidup + masa boot. Tekan untuk buka dashboard |
| **Battery** | Peratus bateri laptop, status cas, anggaran masa berbaki |
| **Disk I/O** | Kelajuan baca (R) dan tulis (W) seluruh PC + graf mini |
| **Top Process** | 3 proses teratas ikut CPU atau RAM (nama sama dijumlahkan, contoh semua proses Chrome). Tekan key untuk tukar CPU ⇄ RAM |
| **CPU Cores** | Satu bar untuk setiap thread CPU (lebih 16 thread dipurata berdekatan) |

Tekan key untuk tukar sementara antara **ring gauge** dan **graf sejarah** (60 sampel).

## Dashboard web (tekan key untuk buka)

Seret **Open Dashboard** ke key, atau pada mana-mana key lain tetapkan **When pressed → Open dashboard**. Key **Uptime** membuka dashboard secara lalai (kerana ia tiada fungsi tekan lain), jadi anda tak perlu key tambahan. Browser akan buka `http://127.0.0.1:39170` (jika port itu sedang digunakan, plugin guna port seterusnya; alamat sebenar sentiasa dibuka oleh key).

Dalam dashboard:
- Kad: CPU (graf + bar setiap core), Memory, Disk, Disk I/O, Network, GPU, Temperature, Ping (min/avg/max/loss), Battery, Uptime, Top processes (tab CPU / RAM)
- Graf besar dengan tetingkap 1 / 2 / 5 / 10 minit; gerakkan tetikus di atas graf untuk nilai tepat
- Kad bertukar border kuning/merah bila melepasi paras amaran/kritikal
- **Settings** (butang ⚙ atau tekan `S`): tema (gelap / cerah / AMOLED / ikut sistem), warna aksen, gaya graf (area / line / bars), kepadatan, bilangan lajur, saiz teks, kekerapan refresh, unit network (bytes / bits), suhu (°C / °F), drive, host ping, susun & sembunyikan kad, dan paras amaran
- Tekan `F` untuk skrin penuh (sesuai untuk monitor kedua), `Esc` tutup panel

Tetapan disimpan dalam `%USERPROFILE%\.ulanzi-system-monitor\dashboard.json` (macOS: `~/.ulanzi-system-monitor/`), jadi kekal walaupun plugin dikemas kini.

**Keselamatan & prestasi**
- Server hanya mendengar pada `127.0.0.1`: tidak boleh diakses dari PC atau telefon lain. Permintaan dengan Host/Origin asing ditolak.
- Data hanya dikumpul selagi tab dashboard terbuka **dan kelihatan**. Bila tab ditutup atau disembunyikan, pengumpulan berhenti.
- Sejarah graf (maks 10 minit) bermula bila dashboard dibuka; ia tidak dirakam di latar.

> Plugin komuniti tidak rasmi untuk Ulanzi Deck. Tiada kaitan dengan Ulanzi. Dibina guna [UlanziDeckPlugin-SDK](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK).

## Pemasangan

**Cara paling mudah:** muat turun fail `.zip` daripada halaman [Releases](../../releases) (sudah termasuk semua kebergantungan), kemudian ikut langkah di bawah.

**Daripada source (git clone):** `node_modules` tidak disimpan dalam repo, jadi pasang dulu (perlu Node.js 18 atau lebih baharu):
```
cd com.ulanzi.systemmonitor.ulanziPlugin
npm install --omit=dev
```
Kemudian salin folder `com.ulanzi.systemmonitor.ulanziPlugin` (termasuk `node_modules` yang baru dipasang) ke folder Plugins seperti di bawah.

1. **Tutup** Ulanzi Studio.
2. Salin folder `com.ulanzi.systemmonitor.ulanziPlugin` (keseluruhan, termasuk `node_modules`) ke folder Plugins Ulanzi Studio (Windows: `%APPDATA%\Ulanzi\UlanziDeck\Plugins\`, macOS: `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/`).
3. Buka semula Ulanzi Studio. Kategori **System Monitor** akan muncul.
4. Seret action ke key. Klik key untuk buka tetapan.

**Mengemas kini daripada versi lama:** tutup Ulanzi Studio, padam folder plugin lama, salin yang baru. Key yang sudah dipasang akan kekal.

## Tetapan setiap key

- **Style**: ring gauge / history graph
- **Color**: Auto (hijau → kuning → merah) atau warna tetap
- **Custom label**, **Refresh** (1 hingga 30 saat)
- **Warning / Critical at**: paras untuk tukar warna (kosong = default). Untuk Ping, unit ialah ms. Untuk Battery, ia paras yang bateri turun **di bawahnya** (default 30% dan 15%); semasa mengecas key jadi cyan.
- **Disk**: drive atau path, contoh `C:`, `D:`, `/`, `/Volumes/Data`
- **Network**: unit Bytes (MB/s) atau Bits (Mbps), nama interface (kosong = adapter lalai)
- **Ping**: host
- **Top Process**: paparan permulaan CPU atau RAM (tekan key untuk tukar sementara) (refresh 5 saat kerana membaca semua proses lebih berat)
- **Temperature**: sensor CPU atau GPU, URL LibreHardwareMonitor (pilihan)

## Suhu CPU di Windows (LibreHardwareMonitor)

Windows biasanya tidak dedahkan suhu CPU kepada aplikasi biasa, jadi key Temperature papar `N/A`. Penyelesaian:

1. Muat turun [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) dan jalankan sebagai Administrator.
2. Pergi **Options → Remote Web Server → Run** (port lalai 8085).
3. Selesai. Plugin akan jumpa sendiri di `http://127.0.0.1:8085/data.json` dan papar suhu (sub-teks "LibreHW Monitor"). Isi medan URL hanya jika anda tukar port.

Plugin hanya cuba LibreHardwareMonitor bila sensor biasa tiada data, dan berhenti mencuba 20 saat jika ia tidak berjalan.

## Nota sensor lain

- **GPU NVIDIA**: guna `nvidia-smi`, jadi peratus, suhu dan VRAM tersedia.
- **GPU AMD / Intel (Windows)**: peratus GPU dibaca daripada performance counter Windows (anggaran). Suhu boleh didapati melalui LibreHardwareMonitor.
- **macOS**: peratus GPU tidak tersedia tanpa akses root.
- **Battery**: PC desktop tiada bateri, jadi key papar "No battery".

## Uji tanpa Ulanzi Studio (Simulator)

1. Dalam repo SDK: `cd UlanziDeckSimulator && npm install && npm start`.
2. Salin folder plugin ke `UlanziDeckSimulator/plugins/`, buka http://127.0.0.1:39069 dan klik **Refresh Plugin List**.
3. Jalankan main service secara manual: `node com.ulanzi.systemmonitor.ulanziPlugin/plugin/app.js`
4. Seret action ke key.

## Debug

- Log SDK dimatikan secara lalai (ia cetak setiap icon base64). Hidupkan dengan pembolehubah persekitaran `SM_DEBUG=1`.
- Ralat plugin ditulis ke log Ulanzi Studio, contoh di Windows: `%APPDATA%\Ulanzi\UlanziStudio\logs\com.ulanzi.ulanzistudio.systemmonitor.log`.

## Struktur

```
com.ulanzi.systemmonitor.ulanziPlugin/
├── manifest.json                 # 14 action
├── plugin/
│   ├── app.js                    # main service: sambung ke Ulanzi Studio, urus semua key
│   ├── monitor.js                # logik satu key (tetapan, sejarah, lukisan)
│   ├── metrics.js                # CPU / core / RAM / disk / I/O / network / GPU / suhu / ping / bateri / proses
│   ├── dashboard.js              # server web tempatan (HTTP + SSE) + simpan tetapan
│   ├── render.js                 # lukis icon PNG (tanpa modul native)
│   └── plugin-common-node/       # SDK rasmi Ulanzi (Node)
├── web/index.html                # dashboard (satu fail, tanpa CDN)
├── property-inspector/           # UI tetapan key (HTML)
├── libs/                         # SDK rasmi Ulanzi (HTML)
├── assets/                       # icon + font
└── node_modules/                 # ws, systeminformation, pureimage
```

## Tambah action baru

1. Tambah entri di `manifest.json` (UUID `com.ulanzi.ulanzistudio.systemmonitor.<nama>`).
2. Tambah nama dalam `TYPES` dan satu `case` dalam `build()` di `plugin/monitor.js`.
3. Tambah `data-for` di `property-inspector/inspector.html` jika perlukan tetapan khas.

Komponen pihak ketiga: lihat `THIRD_PARTY_NOTICES.md`.
