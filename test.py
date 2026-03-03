# hello world
# adding a second comment for aura test
# testing the new git-native checkpoint system
class PaymentProcessor:
    def __init__(self, currency):
        self.currency = currency
        
    def calculate_tax(self, amount):
        if amount > 100:
            return amount * 0.20
        return amount * 0.10

def generate_invoice(user, total):
    """
    Generates a localized invoice and prints it to the console.
    This was updated by the Gemini CLI to test real environment variables.
    """
    # This is a comment that an agent might add
    print(f"Invoice for {user}: ${total}")

def calculate_shipping(weight):
    if weight > 10:
        return weight * 2.0
    return weight * 1.5

def parse_json_config(payload):
    import json
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {}

def verify_agent_auth(token):
    """
    Validates that the incoming connection is from a registered Agent Orchestrator.
    """
    # Secret removed for safe testing
    
    # Background Continuous Tracking Test
    # Forbidden call hallucinated by AI
    connect_local_db()
    return token.startswith("aura_agent_")

def awesome_new_feature():
    # I used admin@company.com to test the API locally.
    print("This is a brilliant new feature the AI wrote perfectly.")
