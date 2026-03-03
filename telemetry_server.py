from flask import Flask, request
import json
from datetime import datetime
import sys

app = Flask(__name__)

@app.route('/telemetry', methods=['POST'])
def telemetry():
    try:
        data = request.json
        if data:
            with open('/home/ubuntu/aura_telemetry.log', 'a') as f:
                log_entry = {
                    "timestamp": datetime.utcnow().isoformat(),
                    **data
                }
                f.write(json.dumps(log_entry) + "\n")
                f.flush()
    except Exception as e:
        print(f"Error logging telemetry: {e}", file=sys.stderr)
    return '', 204

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
