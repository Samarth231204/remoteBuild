# Minimal virtual-display container for GUI apps with no server mode
# (the target is closed tools like Cursor/Antigravity; this image itself
# doesn't bake in any specific app — the entrypoint launches whatever
# GUI_APP_CMD is set to, defaulting to a lightweight stand-in editor).
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    xterm \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 6080
ENTRYPOINT ["/entrypoint.sh"]
