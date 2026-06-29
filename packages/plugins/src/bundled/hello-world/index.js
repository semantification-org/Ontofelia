export default {
  async activate(context) {
    context.registerCommand({
      name: 'hello',
      description: 'Sagt Hallo',
      handler: async (input) => `Hallo! Du hast gesagt: "${input}"`
    });
  },
  async deactivate() {}
};
