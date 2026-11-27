/** Routes this call's playback elements to a user-selected speaker. */
export class AudioOutput {
  private readonly elements = new Set<HTMLMediaElement>();
  private readonly pendingRoutes = new WeakMap<HTMLMediaElement, Promise<void>>();
  private deviceId = '';

  register(element: HTMLMediaElement): () => void {
    this.elements.add(element);
    if (this.deviceId && typeof element.setSinkId === 'function') {
      void this.route(element, this.deviceId).catch(() => undefined);
    }
    return () => { this.elements.delete(element); };
  }

  async select(deviceId: string, document: Document): Promise<void> {
    const probe = document.createElement('audio');
    // Validate permission even in an empty room, while the user is choosing a device.
    await probe.setSinkId(deviceId);
    const previous = this.deviceId;
    this.deviceId = deviceId;
    const results = await Promise.allSettled([...this.elements].map((element) => this.route(element, deviceId)));
    if (results.some((result) => result.status === 'rejected')) {
      this.deviceId = previous;
      await Promise.allSettled([...this.elements].map((element) => this.route(element, previous)));
      throw new Error('Could not change the audio output for the call');
    }
  }

  private route(element: HTMLMediaElement, deviceId: string): Promise<void> {
    // A newly registered track may still be applying its route when a selection rolls back.
    const previous = this.pendingRoutes.get(element);
    const change = previous
      ? previous.catch(() => undefined).then(() => element.setSinkId(deviceId))
      : element.setSinkId(deviceId);
    this.pendingRoutes.set(element, change);
    return change;
  }
}
