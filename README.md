# P2P Screen Share Desktop (Windows)

Electron desktop app for peer-to-peer screen sharing with system audio using PeerJS cloud signaling.

## Stack

- Electron `40.6.0`
- PeerJS `1.5.5`
- WebRTC `getDisplayMedia`

## Features

- Auto-generated Peer ID on launch + copy button.
- Connect to friend by Peer ID over PeerJS cloud signaling.
- Mandatory system-audio capture request:
  - Uses `audio: { systemAudio: "include" }`
  - Validates `stream.getAudioTracks()` and blocks sharing if audio is missing.
- Local preview (muted).
- Remote stream view (unmuted, controls enabled).
- Auto-minimize app window when sharing starts to avoid infinite mirror effect.
- Stop sharing button that stops tracks, closes outgoing media call, and restores window.
- Auto-answer incoming media calls from the connected peer.
- Basic unreachable cloud-server handling and reconnect action.

## Run

```bash
npm install
npm start
```

## TURN Configuration (For Different Networks)

By default, the app runs in STUN-only mode (best for same LAN/private home network).
For reliable cross-network connection, set TURN env vars before `npm start`.

PowerShell example:

```powershell
$env:P2P_TURN_URLS="turn:your-turn-host:3478?transport=udp,turn:your-turn-host:3478?transport=tcp"
$env:P2P_TURN_USERNAME="your-turn-username"
$env:P2P_TURN_CREDENTIAL="your-turn-password"
npm start
```

## Usage

1. Launch app and wait until your Peer ID appears.
2. Send your ID to your friend and get theirs.
3. Enter friend's ID and click `Connect`.
4. Click `Start Sharing`.
5. In the Windows share picker, select screen/window and ensure **Share system audio** is enabled.
6. To end, click `Stop Sharing`.

## Notes

- Best results are on private home networks and allowed firewall rules.
- If signaling fails, click `Reconnect Signal`.
- If connection stays in dialing, the app now auto-times out and resets after ~18s so you can retry cleanly.
- On first run, allow Windows Firewall access for private networks.
- If you see `Failed to resolve address for eu-0.turn.peerjs.com` or `us-0.turn.peerjs.com`, this is DNS failure for PeerJS default TURN hosts. The app now avoids those hosts and uses custom ICE settings.
- Screen capture now tries multiple compatibility modes if a specific display-audio constraint is unsupported by your runtime.
