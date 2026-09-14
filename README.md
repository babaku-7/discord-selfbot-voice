# Discord Stay Voice

Self-bot Discord sederhana yang hanya login dan tetap terhubung ke voice

> [!WARNING]
> **Risiko Penggunaan Self-Bot**
> Menggunakan akun pengguna (self-bot) untuk otomatisasi adalah pelanggaran
> terhadap [Persyaratan Layanan Discord](https://discord.com/terms) dan dapat
> menyebabkan akun diblokir permanen. Gunakan dengan risiko Anda sendiri.

> [!IMPORTANT]
> Proyek ini didasarkan pada `discord.js-selfbot-v13` yang dilisensikan di
> bawah **GPL-3.0**. Oleh karena itu, proyek ini juga tunduk pada lisensi yang
> sama.

## Setup Lokal

```bash
npm install
export DISCORD_TOKEN=YOUR_DISCORD_TOKEN
export VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID
npm start
```

Bot akan bergabung ke voice channel setelah login dan mencoba bergabung
kembali jika koneksinya terputus.

## Custom Rich Presence

Repository ini mendukung Custom Rich Presence yang dikonfigurasi melalui
`.env` dan otomatis aktif setelah selfbot berhasil login.

```env
RPC_ENABLED=true
RPC_APPLICATION_ID=123456789012345678
RPC_NAME=My Custom RPC
RPC_DETAILS=Playing on Discord
RPC_STATE=Indonesia
RPC_LARGE_IMAGE=
RPC_LARGE_TEXT=
RPC_SMALL_IMAGE=
RPC_SMALL_TEXT=
RPC_BUTTON1_NAME=
RPC_BUTTON1_URL=
RPC_BUTTON2_NAME=
RPC_BUTTON2_URL=
RPC_START_TIMESTAMP=true
```

Fungsi masing-masing variable:

* `RPC_ENABLED` — mengaktifkan/nonaktifkan RPC.
* `RPC_APPLICATION_ID` — Application ID aplikasi Discord yang digunakan oleh Rich Presence.
* `RPC_NAME` — nama activity.
* `RPC_DETAILS` — detail activity.
* `RPC_STATE` — state/status tambahan.
* `RPC_LARGE_IMAGE` — large image asset.
* `RPC_LARGE_TEXT` — tooltip large image.
* `RPC_SMALL_IMAGE` — small image asset.
* `RPC_SMALL_TEXT` — tooltip small image.
* `RPC_BUTTON1_NAME` — nama button pertama.
* `RPC_BUTTON1_URL` — URL button pertama.
* `RPC_BUTTON2_NAME` — nama button kedua.
* `RPC_BUTTON2_URL` — URL button kedua.
* `RPC_START_TIMESTAMP` — jika `true`, menampilkan elapsed time sejak RPC diaktifkan.

Contoh konfigurasi lengkap:

```env
RPC_ENABLED=true
RPC_APPLICATION_ID=123456789012345678
RPC_NAME=My Custom RPC
RPC_DETAILS=Playing Discord
RPC_STATE=Online
RPC_LARGE_IMAGE=
RPC_LARGE_TEXT=My Large Image
RPC_SMALL_IMAGE=
RPC_SMALL_TEXT=My Small Image
RPC_BUTTON1_NAME=GitHub
RPC_BUTTON1_URL=https://github.com
RPC_BUTTON2_NAME=Website
RPC_BUTTON2_URL=https://example.com
RPC_START_TIMESTAMP=true
```

### Cara mendapatkan Application ID

Application ID berasal dari
[Discord Developer Portal](https://discord.com/developers/applications):
buat atau pilih aplikasi, lalu salin **Application ID** dari halaman
General Information.

Application ID **BUKAN**:

* Discord User ID
* Server/Guild ID
* Channel ID
* Discord token

Jangan pernah membagikan atau menampilkan Discord token di dokumentasi,
konfigurasi publik, atau source code.

### Asset Image

Image Rich Presence menggunakan asset yang terkait dengan aplikasi Discord
yang dipakai (`RPC_APPLICATION_ID`). Unggah gambar di halaman aplikasi pada
Developer Portal (Rich Presence / Art Assets), lalu isi `RPC_LARGE_IMAGE`
atau `RPC_SMALL_IMAGE` dengan nama atau ID asset tersebut. `RPC_LARGE_TEXT`
dan `RPC_SMALL_TEXT` menjadi tooltip saat kursor diarahkan ke gambar.
Field yang dikosongkan akan dilewati.

Implementasi `RichPresence` yang dipakai project ini juga mendukung format
image berikut:

* ID asset aplikasi (angka 17–19 digit)
* URL `cdn.discordapp.com` / `media.discordapp.net`
* Media proxy (`mp:...`, `external/...`)
* `youtube:...`, `spotify:...`, `twitch:...`

Untuk URL gambar eksternal, tersedia API existing:

```js
const { RichPresence } = require('./src/index.js');

// Maksimal 2 URL yang valid, mengembalikan external assets via Discord API.
const assets = await RichPresence.getExternal(client, applicationId, imageUrl1, imageUrl2);
```

Jika asset tidak valid, asset tersebut dilewati dengan warning dan RPC tetap
berjalan tanpa image.

### Buttons

Maksimal 2 button dapat digunakan. Setiap button membutuhkan pasangan yang
lengkap:

* name (`RPC_BUTTON1_NAME` / `RPC_BUTTON2_NAME`)
* URL valid (`RPC_BUTTON1_URL` / `RPC_BUTTON2_URL`)

Jika salah satu pasangan tidak lengkap atau URL tidak valid, button tersebut
dilewati (dengan warning) dan tidak akan muncul. Validasi dilakukan oleh
`RichPresence.setButtons()`.

### Timestamp

Jika `RPC_START_TIMESTAMP=true`, timestamp mulai dibuat sekali ketika RPC
diaktifkan dan elapsed time berjalan berdasarkan timestamp tersebut
(Discord yang menghitungnya, tanpa interval refresh).

### Menonaktifkan RPC

```env
RPC_ENABLED=false
```

Voice functionality tetap berjalan ketika RPC dinonaktifkan atau konfigurasi
RPC tidak lengkap (misalnya `RPC_APPLICATION_ID` kosong). Kegagalan RPC
tidak menghentikan voice connection.

### Contoh hasil

Gambaran teks status yang tampil (tampilan persis di Discord dapat berbeda
tergantung client dan API Discord):

```text
My Custom RPC
Playing Discord
Online

[elapsed time]

[GitHub] [Website]
```

> [!NOTE]
> Project ini menggunakan selfbot/user account, dan penggunaan selfbot dapat
> bertentangan dengan Discord Terms of Service.

## Deploy ke Render

1. Hubungkan repository ke Render sebagai Web Service.
2. Gunakan **Build Command** `npm install`.
3. Gunakan **Start Command** `npm start`.
4. Tambahkan environment variables berikut:
   - `DISCORD_TOKEN`: token akun Discord.
   - `VOICE_CHANNEL_ID`: ID voice channel tujuan.
   - Variable `RPC_*` (opsional, lihat section Custom Rich Presence).

Health check tersedia melalui port yang diberikan oleh environment `PORT`.

## License

GPL-3.0
