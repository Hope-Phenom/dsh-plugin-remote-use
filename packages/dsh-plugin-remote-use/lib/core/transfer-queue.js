/**
 * One serial lane per peer, for file transfers.
 *
 * WHY THIS IS NOT THE TASK QUEUE. `RemoteProvider`'s `serialQueue` exists because a desktop is an
 * exclusive resource: two tasks driving one mouse fight, so they run one at a time. Transfers must
 * NOT share that lane, because a 2 GiB copy would then occupy the worker's GUI slot and block the
 * visual work it was meant to support -- and the whole point of moving bytes over the relay's HTTP
 * surface instead of through the ACP session is that a copy never touches the GUI at all.
 *
 * They still need *a* lane of their own: two transfers to one peer make the disk seek between two
 * streams and halve both. So: one transfer at a time per peer, on a queue of its own.
 *
 * A failed transfer must not poison the lane. The stored chain swallows the rejection -- the caller
 * still sees its own error from `run`'s return value -- because an unhandled rejection left on a
 * shared chain would fail the *next* transfer for a reason that has nothing to do with it.
 */
export function makeTransferQueue() {
  /** @type {Map<string, Promise<void>>} */
  const lanes = new Map()
  /** @type {Map<string, number>} */
  const busy = new Map()

  const settle = (peerId) => () => {
    const left = (busy.get(peerId) ?? 1) - 1
    if (left <= 0) busy.delete(peerId)
    else busy.set(peerId, left)
  }

  return {
    /**
     * Run `job` after everything already queued for this peer.
     *
     * @template T
     * @param {string} peerId
     * @param {() => Promise<T>} job
     * @returns {Promise<T>} rejects with the job's own error, if it has one
     */
    run(peerId, job) {
      busy.set(peerId, (busy.get(peerId) ?? 0) + 1)
      const previous = lanes.get(peerId) ?? Promise.resolve()
      // `then(job, job)`: the next job runs whether the previous one resolved or rejected.
      const next = previous.then(job, job)
      lanes.set(peerId, next.then(() => {}, () => {}))
      return next.finally(settle(peerId))
    },

    /**
     * How many transfers are queued or running for a peer.
     *
     * Read BEFORE `run` to report "waited behind N transfers". Without that number a slow copy is
     * indistinguishable from a broken one -- the operator watches a tool call hang and cannot tell
     * whether it is queued, transferring, or stuck.
     */
    depth(peerId) {
      return busy.get(peerId) ?? 0
    },
  }
}
