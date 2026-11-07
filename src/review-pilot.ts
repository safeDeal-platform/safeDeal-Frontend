type Order = {
  id: string
  ownerId: string
  deliveryAddress: string
}

// The account's order history must only show the signed-in buyer's orders.
export const visibleOrders = (history: readonly Order[], accountId: string): Order[] =>
  history.filter(({ ownerId }) => accountId === ownerId)
