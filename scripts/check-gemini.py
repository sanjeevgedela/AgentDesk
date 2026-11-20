"""Print up to three active events from Gemini Prediction Markets."""

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen


def main() -> int:
    endpoint = "https://api.gemini.com/v1/prediction-markets/events"
    query = urlencode({"status": "active", "limit": 3})

    try:
        with urlopen(f"{endpoint}?{query}", timeout=10) as response:
            payload = json.load(response)
    except HTTPError as error:
        print(f"Gemini returned HTTP {error.code}.", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, ValueError) as error:
        print(f"Could not read Gemini's response: {error}", file=sys.stderr)
        return 1

    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        print("Gemini's response is missing the event list.", file=sys.stderr)
        return 1

    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
