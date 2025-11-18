/**
 * 错误规则检测引擎
 *
 * 特性：
 * - 按规则类型分组缓存（regex/contains/exact）
 * - 性能优先的检测顺序（包含 → 精确 → 正则）
 * - 单例模式，全局复用
 * - 支持热重载
 * - ReDoS 风险检测（safe-regex）
 * - EventEmitter 驱动的自动缓存刷新
 * - 延迟初始化，避免与数据库迁移竞争
 * - 优雅降级，迁移未完成时返回未匹配
 */

import { getActiveErrorRules } from "@/repository/error-rules";
import { logger } from "@/lib/logger";
import { eventEmitter } from "@/lib/event-emitter";
import safeRegex from "safe-regex";

/**
 * 错误检测结果
 */
export interface ErrorDetectionResult {
  matched: boolean;
  category?: string; // 触发的错误分类
  pattern?: string; // 匹配的规则模式
  matchType?: string; // 匹配类型（regex/contains/exact）
}

/**
 * 缓存的正则规则
 */
interface RegexPattern {
  pattern: RegExp;
  category: string;
  description?: string;
}

/**
 * 缓存的包含规则
 */
interface ContainsPattern {
  text: string;
  category: string;
  description?: string;
}

/**
 * 缓存的精确规则
 */
interface ExactPattern {
  text: string;
  category: string;
  description?: string;
}

/**
 * 错误规则检测缓存类
 */
class ErrorRuleDetector {
  private regexPatterns: RegexPattern[] = [];
  private containsPatterns: ContainsPattern[] = [];
  private exactPatterns: Map<string, ExactPattern> = new Map();
  private lastReloadTime: number = 0;
  private isLoading: boolean = false;
  private isInitialized: boolean = false;

  constructor() {
    // 延迟初始化：不在构造函数中加载，避免与数据库迁移竞争
    // 首次 detect() 调用时会触发 ensureInitialized()

    // 监听数据库变更事件，自动刷新缓存
    eventEmitter.on("errorRulesUpdated", () => {
      this.reload().catch((error) => {
        logger.error("[ErrorRuleDetector] Failed to reload cache on event:", error);
      });
    });
  }

  /**
   * 确保已初始化（延迟加载）
   * 在首次调用 detect() 时触发
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // 避免并发初始化
    if (this.isLoading) {
      // 等待当前加载完成
      while (this.isLoading) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    await this.reload();
    this.isInitialized = true;
  }

  /**
   * 从数据库重新加载错误规则
   */
  async reload(): Promise<void> {
    if (this.isLoading) {
      logger.warn("[ErrorRuleDetector] Reload already in progress, skipping");
      return;
    }

    this.isLoading = true;

    try {
      logger.info("[ErrorRuleDetector] Reloading error rules from database...");

      const rules = await getActiveErrorRules();

      // 清空旧缓存
      this.regexPatterns = [];
      this.containsPatterns = [];
      this.exactPatterns.clear();

      // 按类型分组加载规则
      let validRegexCount = 0;
      let skippedRedosCount = 0;

      for (const rule of rules) {
        switch (rule.matchType) {
          case "contains": {
            const lowerText = rule.pattern.toLowerCase();
            this.containsPatterns.push({
              text: lowerText,
              category: rule.category,
              description: rule.description ?? undefined,
            });
            break;
          }

          case "exact": {
            const lowerText = rule.pattern.toLowerCase();
            this.exactPatterns.set(lowerText, {
              text: lowerText,
              category: rule.category,
              description: rule.description ?? undefined,
            });
            break;
          }

          case "regex": {
            // 使用 safe-regex 检测 ReDoS 风险
            try {
              if (!safeRegex(rule.pattern)) {
                logger.warn(
                  `[ErrorRuleDetector] ReDoS risk detected in pattern: ${rule.pattern}, skipping`
                );
                skippedRedosCount++;
                break;
              }

              const pattern = new RegExp(rule.pattern, "i");
              this.regexPatterns.push({
                pattern,
                category: rule.category,
                description: rule.description ?? undefined,
              });
              validRegexCount++;
            } catch (error) {
              logger.error(`[ErrorRuleDetector] Invalid regex pattern: ${rule.pattern}`, error);
            }
            break;
          }

          default:
            logger.warn(`[ErrorRuleDetector] Unknown match type: ${rule.matchType}`);
        }
      }

      this.lastReloadTime = Date.now();
      this.isInitialized = true;

      logger.info(
        `[ErrorRuleDetector] Loaded ${rules.length} error rules: ` +
          `contains=${this.containsPatterns.length}, exact=${this.exactPatterns.size}, ` +
          `regex=${validRegexCount}${skippedRedosCount > 0 ? ` (skipped ${skippedRedosCount} ReDoS)` : ""}`
      );
    } catch (error) {
      // 检查是否是表不存在错误（数据库迁移未完成）
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('relation "error_rules" does not exist')) {
        logger.warn(
          "[ErrorRuleDetector] error_rules table not found, database migration may not be complete yet. " +
            "Error rules will be disabled until migration completes."
        );
      } else {
        logger.error("[ErrorRuleDetector] Failed to reload error rules:", error);
      }
      // 失败时不清空现有缓存，保持降级可用
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 检测错误消息是否匹配任何规则
   *
   * 检测顺序（性能优先）：
   * 1. 包含匹配（最快，O(n*m)）
   * 2. 精确匹配（使用 Set，O(1)）
   * 3. 正则匹配（最慢，但最灵活）
   *
   * @param errorMessage - 错误消息
   * @returns 检测结果
   */
  async detectAsync(errorMessage: string): Promise<ErrorDetectionResult> {
    if (!errorMessage || errorMessage.length === 0) {
      return { matched: false };
    }

    await this.ensureInitialized();

    const lowerMessage = errorMessage.toLowerCase();
    const trimmedMessage = lowerMessage.trim();

    // 1. 包含匹配（最快）
    for (const pattern of this.containsPatterns) {
      if (lowerMessage.includes(pattern.text)) {
        return {
          matched: true,
          category: pattern.category,
          pattern: pattern.text,
          matchType: "contains",
        };
      }
    }

    // 2. 精确匹配（O(1) 查询）
    const exactMatch = this.exactPatterns.get(trimmedMessage);
    if (exactMatch) {
      return {
        matched: true,
        category: exactMatch.category,
        pattern: exactMatch.text,
        matchType: "exact",
      };
    }

    // 3. 正则匹配（最慢，但最灵活）
    for (const { pattern, category } of this.regexPatterns) {
      if (pattern.test(errorMessage)) {
        return {
          matched: true,
          category,
          pattern: pattern.source,
          matchType: "regex",
        };
      }
    }

    return { matched: false };
  }

  detect(errorMessage: string): ErrorDetectionResult {
    // 保持向后兼容的同步接口，当未初始化时返回未匹配
    if (!this.isInitialized) {
      // 异步触发初始化，但不阻塞当前调用
      this.ensureInitialized().catch((error) => {
        logger.error("[ErrorRuleDetector] Failed to initialize during sync detect:", error);
      });

      return { matched: false };
    }

    if (!errorMessage || errorMessage.length === 0) {
      return { matched: false };
    }

    const lowerMessage = errorMessage.toLowerCase();
    const trimmedMessage = lowerMessage.trim();

    // 1. 包含匹配（最快）
    for (const pattern of this.containsPatterns) {
      if (lowerMessage.includes(pattern.text)) {
        return {
          matched: true,
          category: pattern.category,
          pattern: pattern.text,
          matchType: "contains",
        };
      }
    }

    // 2. 精确匹配（O(1) 查询）
    const exactMatch = this.exactPatterns.get(trimmedMessage);
    if (exactMatch) {
      return {
        matched: true,
        category: exactMatch.category,
        pattern: exactMatch.text,
        matchType: "exact",
      };
    }

    // 3. 正则匹配（最慢，但最灵活）
    for (const { pattern, category } of this.regexPatterns) {
      if (pattern.test(errorMessage)) {
        return {
          matched: true,
          category,
          pattern: pattern.source,
          matchType: "regex",
        };
      }
    }

    return { matched: false };
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    return {
      regexCount: this.regexPatterns.length,
      containsCount: this.containsPatterns.length,
      exactCount: this.exactPatterns.size,
      totalCount:
        this.regexPatterns.length + this.containsPatterns.length + this.exactPatterns.size,
      lastReloadTime: this.lastReloadTime,
      isLoading: this.isLoading,
    };
  }

  /**
   * 检查缓存是否为空
   */
  isEmpty(): boolean {
    return (
      this.regexPatterns.length === 0 &&
      this.containsPatterns.length === 0 &&
      this.exactPatterns.size === 0
    );
  }
}

/**
 * 全局单例导出
 */
export const errorRuleDetector = new ErrorRuleDetector();
