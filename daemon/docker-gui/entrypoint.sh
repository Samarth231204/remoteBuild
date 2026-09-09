#!/bin/bash
set -e

export DISPLAY=:1
VNC_PASSWORD="${VNC_PASSWORD:-changeme}"
GUI_APP_CMD="${GUI_APP_CMD:-xterm}"

Xvfb :1 -screen 0 1280x800x24 &
sleep 1

fluxbox &
sleep 1

x11vnc -display :1 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" &
sleep 1

websockify --web=/usr/share/novnc 6080 localhost:5900 &
sleep 1

eval "$GUI_APP_CMD" &

wait
