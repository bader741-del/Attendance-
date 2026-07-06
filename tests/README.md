# اختبارات المنصة

اختبارات دخانية وانحدار تعمل عبر jsdom (دون متصفح):

```bash
npm install jsdom        # مرة واحدة
node tests/smoke.js             # خريطة العمليات (المرحلة 5)
node tests/smoke-exec.js        # مركز القيادة (المرحلة 10)
node tests/smoke-regression.js  # الصفحات الأصلية (index/admin/employee + الدخول)
```

تزرع الاختبارات بيانات محلية وهمية في jsdom فقط — لا تمس Supabase ولا بيانات المتصفح الحقيقية.
