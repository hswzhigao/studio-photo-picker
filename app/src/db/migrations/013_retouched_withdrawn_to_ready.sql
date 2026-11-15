-- 撤回语义修正：撤回 = 退回草稿（ready），可修复关联后重新发布。
-- 归一化历史遗留的 withdrawn 行，使其重新可发布。
UPDATE retouched_photo SET status='ready' WHERE status='withdrawn';
