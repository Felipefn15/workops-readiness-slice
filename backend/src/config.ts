export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://workops:workops@localhost:5455/workops';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://workops:workops@localhost:5455/workops_test';
export const PORT = Number(process.env.PORT ?? 3000);
