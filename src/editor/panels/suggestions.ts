/** Starter prompts for the agent's empty state. A different set is shown each time the chat opens. */
const SUGGESTIONS = [
  'Design a pricing section with three tiers',
  'Make the selected frame responsive at 390px',
  'Replace placeholder copy with real content',
  'Add a hero with a headline, subcopy and two buttons',
  'Build a testimonial row with three quote cards',
  'Turn this frame into a dark-mode variant',
  'Create a sign-up form with labelled inputs',
  'Add a footer with four link columns',
  'Make the spacing on this frame consistent',
  'Design a feature grid with icons and short captions',
]

/** Pick `count` different suggestions at random. */
export function pickSuggestions(count = 3): string[] {
  const pool = [...SUGGESTIONS]
  const picked: string[] = []
  while (picked.length < count && pool.length) {
    const [next] = pool.splice(Math.floor(Math.random() * pool.length), 1)
    picked.push(next)
  }
  return picked
}
