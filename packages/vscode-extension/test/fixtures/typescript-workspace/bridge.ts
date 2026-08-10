export function bridgeGreeting(name: string): string {
  return `Hello, ${name}`;
}

const greeting: number = bridgeGreeting("Codex");
bridgeGreeting("Bridge");
console.log(greeting);
