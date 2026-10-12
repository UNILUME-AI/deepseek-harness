export const name = 'fixture-local-pack'

export function apply(ctx) {
  ctx.effect(() => () => {}, 'fixture-local-pack')
}
