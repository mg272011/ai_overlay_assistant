tell application "System Events"
	tell application process "Vivaldi"
		set frontmost to true
		tell window 1
			repeat with e in (entire contents of window 1)
				if description of e is "Search" then
					perform action "AXPress" of e
					exit repeat
				end if
			end repeat
		end tell
	end tell
end tell
