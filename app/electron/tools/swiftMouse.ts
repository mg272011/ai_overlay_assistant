import { spawn } from 'child_process';
import * as path from 'path';

const AGENT_MOUSE_PATH = path.join(__dirname, '../../swift/AgentMouse/AgentMouse');

export class SwiftMouse {
  /**
   * Move the mouse to a position with human-like Bezier curve motion
   */
  static async move(x: number, y: number, duration: number = 0.6): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['move', x.toString(), y.toString(), duration.toString()]);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse move failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Click at the current mouse position
   */
  static async click(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['click']);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse click failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Right click at the current mouse position
   */
  static async rightClick(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['rightclick']);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse rightclick failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Double click at the current mouse position
   */
  static async doubleClick(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['doubleclick']);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse doubleclick failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Get the current mouse position
   */
  static async getPosition(): Promise<{ x: number; y: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['position']);
      let output = '';
      
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          const [x, y] = output.trim().split(',').map(Number);
          resolve({ x, y });
        } else {
          reject(new Error(`AgentMouse position failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Scroll the mouse wheel
   */
  static async scroll(x: number = 0, y: number = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['scroll', x.toString(), y.toString()]);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse scroll failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Type text with natural human-like timing
   */
  static async type(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(AGENT_MOUSE_PATH, ['type', text]);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AgentMouse type failed with code ${code}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
  
  /**
   * Move and click - common pattern
   */
  static async moveAndClick(x: number, y: number, duration: number = 0.6): Promise<void> {
    await this.move(x, y, duration);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small pause
    await this.click();
  }
  
  /**
   * Move and double click - common pattern
   */
  static async moveAndDoubleClick(x: number, y: number, duration: number = 0.6): Promise<void> {
    await this.move(x, y, duration);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small pause
    await this.doubleClick();
  }
} 