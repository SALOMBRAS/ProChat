import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeSocket } from '../src/realtime.js';

class Socket implements RealtimeSocket { readyState = 1; readonly messages: string[] = []; send(data: string) { this.messages.push(data); } }
describe('RealtimeHub', () => {
  it('delivers events only to clients in the matching workspace', () => {
    const hub = new RealtimeHub(); const workspaceA = new Socket(); const workspaceB = new Socket(); hub.add(workspaceA, 'workspace-a'); hub.add(workspaceB, 'workspace-b');
    hub.publish('workspace-a', 'message.received', { messageId: 'message-a' });
    expect(JSON.parse(workspaceA.messages[0]!)).toMatchObject({ eventType: 'message.received', workspaceId: 'workspace-a', payload: { messageId: 'message-a' } }); expect(workspaceB.messages).toHaveLength(0);
  });
});
