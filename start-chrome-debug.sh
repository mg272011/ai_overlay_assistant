#!/bin/bash

echo "🚀 Starting Chrome with debug port for nanobrowser..."
echo "This will allow nanobrowser to control your existing Chrome"
echo ""

# Close existing Chrome instances
echo "📝 Step 1: Closing existing Chrome instances..."
pkill -f "Google Chrome"
sleep 2

# Start Chrome with debug port
echo "🌐 Step 2: Starting Chrome with remote debugging..."
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &

echo "✅ Chrome started! You can now use nanobrowser commands."
echo "🎯 Nanobrowser will control this Chrome window."
echo ""
echo "To stop: Close this terminal or press Ctrl+C" 