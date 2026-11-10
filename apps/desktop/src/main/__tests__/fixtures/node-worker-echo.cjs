process.on("message", (message) => {
  if (message.stop) process.exit(0);
  process.send({ value: message.value, inherited: process.env.PWRAGENT_WORKER_TEST_VALUE });
});
