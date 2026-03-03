import sqlite3
import json

# This script simulates the hidden SQLite database that Cursor uses to store its chat history.
# In a real environment, this lives in ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/state.vscdb
conn = sqlite3.connect('.cursor_mock.vscdb')
c = conn.cursor()

# Cursor stores its workspace state in a key-value table
c.execute('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE, value TEXT)')

# Simulate the JSON payload of the last chat interaction
chat_data = {
    "last_message": "I noticed a potential race condition. I refactored the concurrent parser loops to use Mutex locks, ensuring thread safety during AST generation."
}

c.execute('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)', ('cursor.chat.history', json.dumps(chat_data)))
conn.commit()
conn.close()

print("Mock Cursor SQLite database created.")
