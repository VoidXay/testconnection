# Guru 3.2

Private voice rooms with profile, low-latency audio and screen sharing.

## 3.2 fixes

- Presentation uses the full meeting stage instead of consuming only part of the viewport.
- Remote participant cards float over the presentation and stay compact.
- Shared video is always fitted without cropping.
- Screen capture is capped to 15 FPS and approximately 720p at the sender.
- Screen bitrate is adaptive to participant count (900 / 650 / 450 Kbps per peer).
- Audio sender is explicitly high priority while screen video is low priority.
- Current Guru tab is excluded from the Chromium share picker when supported to avoid recursive screen capture.
- Heavy blur is reduced while a presentation is active.
- Existing TURN, ICE recovery, profile and mute synchronization are preserved.

## Deploy

Use the same Render and Netlify settings/environment variables from Guru 3.1.
