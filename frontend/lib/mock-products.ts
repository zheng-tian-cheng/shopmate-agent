// 第 1 阶段的虚构商品，只用于自动化测试（业务规则、会话流程），不在正式展示中使用。
// 测试里通过 setCatalogForTesting(MOCK_PRODUCTS) 切换；界面始终读取 data/products.json 的真实商品。

import type { Product } from './products.ts';

const MOCK_PRICE = '模拟价格，无真实商家来源';

export const MOCK_PRODUCTS: readonly Product[] = [
  {
    id: 'mock-01', isMock: true, brand: null, model: null, name: '候选 A · 静听', subtitle: '让通勤少一点打扰', wearingStyle: '入耳式', anc: true,
    price: { amount: 259, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: 8, batteryConditions: '模拟值，测试条件未提供',
    weightG: null, tradeoff: '入耳式佩戴；舒适度需要实际试戴。', tone: 'sage',
  },
  {
    id: 'mock-02', isMock: true, brand: null, model: null, name: '候选 B · 轻行', subtitle: '把预算留给喜欢的事', wearingStyle: '入耳式', anc: true,
    price: { amount: 179, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: 6, batteryConditions: '模拟值，测试条件未提供',
    weightG: 4.5, tradeoff: '模拟单次续航较短，不代表真实使用表现。', tone: 'cream',
  },
  {
    id: 'mock-03', isMock: true, brand: null, model: null, name: '候选 C · 漫步', subtitle: '一种不同的佩戴选择', wearingStyle: '半入耳式', anc: false,
    price: { amount: 229, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: 7, batteryConditions: '模拟值，测试条件未提供',
    weightG: 4.1, tradeoff: '不支持主动降噪，不满足“必须 ANC”的需求。', tone: 'lilac',
  },
  {
    id: 'mock-04', isMock: true, brand: null, model: null, name: '候选 D · 长听', subtitle: '为更长的旅程准备', wearingStyle: '入耳式', anc: true,
    price: { amount: 369, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: 10, batteryConditions: '模拟值，测试条件未提供',
    weightG: 5.2, tradeoff: '价格较高；续航为模拟值，测试条件未提供。', tone: 'sand',
  },
  {
    id: 'mock-05', isMock: true, brand: null, model: null, name: '候选 E · 围听', subtitle: '把安静留给自己', wearingStyle: '头戴式', anc: true,
    price: { amount: 329, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: 30, batteryConditions: '模拟值，测试条件未提供',
    weightG: 245, tradeoff: '头戴式体积较大，通勤携带不如入耳式方便。', tone: 'mist',
  },
  {
    id: 'mock-06', isMock: true, brand: null, model: null, name: '候选 F · 简听', subtitle: '资料不全的示例', wearingStyle: '入耳式', anc: 'unknown',
    price: { amount: 189, conditions: MOCK_PRICE, verifiedAt: null }, batteryHours: null, batteryConditions: null,
    weightG: null, tradeoff: '降噪资料缺失：不能作为“必须主动降噪”的合格候选。', tone: 'stone',
  },
  {
    id: 'mock-07', isMock: true, brand: null, model: null, name: '候选 G · 待定', subtitle: '价格待核验的示例', wearingStyle: '半入耳式', anc: true,
    price: { amount: null, conditions: '价格待核验', verifiedAt: null }, batteryHours: 9, batteryConditions: '模拟值，测试条件未提供',
    weightG: null, tradeoff: '没有有效价格：不能声称符合任何预算。', tone: 'rose',
  },
];
