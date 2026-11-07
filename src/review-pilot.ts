type Order = {
  id: string
  ownerId: string
  deliveryAddress: string
}

// The account's order history must only show the signed-in buyer's orders.
export function visibleOrders(orders: readonly Order[], viewerId: string): Order[] {
  return orders.filter((order) => order.ownerId !== viewerId)
}
